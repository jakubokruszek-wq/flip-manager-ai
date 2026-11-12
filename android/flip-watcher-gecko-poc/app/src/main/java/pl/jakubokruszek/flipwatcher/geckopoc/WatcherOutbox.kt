package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Independent of the existing encrypted local archive and Gecko profile. No token is stored here. */
class WatcherOutbox(context:Context):SQLiteOpenHelper(context,"watcher-outbox-v1.db",null,4) {
    override fun onCreate(db:SQLiteDatabase) {
        db.execSQL("CREATE TABLE outbox (id TEXT PRIMARY KEY, device TEXT NOT NULL, body BLOB NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempt INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, receipt TEXT, source TEXT, post TEXT, saved_at INTEGER)")
        db.execSQL("CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, code TEXT NOT NULL, count INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE scans (slot TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(slot, source))")
        db.execSQL("CREATE TABLE removed_posts (source TEXT NOT NULL, post TEXT NOT NULL, PRIMARY KEY(source,post))")
        createSupportTables(db)
    }
    override fun onUpgrade(db:SQLiteDatabase,old:Int,new:Int){
        if(old<2){
        db.execSQL("ALTER TABLE outbox ADD COLUMN source TEXT")
        db.execSQL("ALTER TABLE outbox ADD COLUMN post TEXT")
        db.execSQL("ALTER TABLE outbox ADD COLUMN saved_at INTEGER")
        db.execSQL("CREATE TABLE removed_posts (source TEXT NOT NULL, post TEXT NOT NULL, PRIMARY KEY(source,post))")
        // Old frozen bodies have no save date. Preserve them, never manufacture an age.
        db.rawQuery("SELECT id,body FROM outbox",null).use{c->while(c.moveToNext()){
            runCatching{val body=JSONObject(open(c.getString(0),c.getBlob(1)))
                val group=body.getString("groupId")
                val row=SavedResultCodec.rows(JSONArray().put(body.getJSONObject("row")),group)?.singleOrNull()
                val ready=row!=null&&OfferQuality.reason(row,body.getJSONArray("photos").length())==null
                db.update("outbox",ContentValues().apply{
                    put("source",group);put("post",body.getJSONObject("row").getString("postId"))
                    // One migration-only replay of the SAME key/body refreshes truthful sale
                    // provenance on Manager records accepted before this quality gate.
                    put("state",if(ready)"pending"else"quality_hold");put("next_at",0);put("attempt",0)
                },"id=?",arrayOf(c.getString(0)))}
        }}
        }
        createSupportTables(db)
    }
    /** Two released branches used schema 3 for different auxiliary tables.
     * Schema 4 unions both layouts without reading or rewriting any frozen body. */
    private fun createSupportTables(db:SQLiteDatabase){
        db.execSQL("CREATE TABLE IF NOT EXISTS scan_failures (slot TEXT NOT NULL, source TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(slot,source))")
        db.execSQL("CREATE TABLE IF NOT EXISTS capture_reports (id TEXT PRIMARY KEY, device TEXT NOT NULL, slot TEXT NOT NULL, source TEXT NOT NULL, body BLOB NOT NULL, sent INTEGER NOT NULL DEFAULT 0)")
    }
    private fun key():SecretKey = synchronized(KEY_LOCK) {
        val store=KeyStore.getInstance("AndroidKeyStore").apply{load(null)}
        (store.getKey("watcher-outbox-v1",null) as? SecretKey)?:KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply{
            init(KeyGenParameterSpec.Builder("watcher-outbox-v1",KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun seal(id:String,body:ByteArray):ByteArray {
        val c=Cipher.getInstance("AES/GCM/NoPadding").apply{init(Cipher.ENCRYPT_MODE,key());updateAAD(id.toByteArray())}
        return c.iv+c.doFinal(body)
    }
    private fun open(id:String,bytes:ByteArray):String {
        val c=Cipher.getInstance("AES/GCM/NoPadding").apply{init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,bytes.copyOfRange(0,12)));updateAAD(id.toByteArray())}
        return String(c.doFinal(bytes.copyOfRange(12,bytes.size)),Charsets.UTF_8)
    }
    /** Body is frozen BEFORE HTTP, with an idempotency key independent of retry time or scan. */
    fun enqueue(device:String,group:WatcherGroup,value:SavedResult) {
        require(SavedResultCodec.rows(JSONArray(value.rows.map(SavedResultCodec::row)),group.id,true,group.type=="PROFILE")==value.rows)
        val db=writableDatabase;db.beginTransaction()
        try {
            var held=db.rawQuery("SELECT COUNT(*) FROM outbox WHERE state='quality_hold'",null).use{it.moveToFirst();it.getInt(0)}
            var pending=db.rawQuery("SELECT COUNT(*) FROM outbox WHERE state NOT IN ('sent','deleted','quality_hold')",null).use{it.moveToFirst();it.getInt(0)}
            var skippedHeld=0
            for(row in value.rows) {
                if(db.rawQuery("SELECT 1 FROM removed_posts WHERE source=? AND post=?",arrayOf(group.key,row.postId)).use{it.moveToFirst()})continue
                val firstSaved=db.rawQuery("SELECT MIN(saved_at) FROM outbox WHERE source=? AND post=?",arrayOf(group.key,row.postId)).use{if(it.moveToFirst()&&!it.isNull(0))it.getLong(0)else value.savedAt}
                val photos=value.photos.filter{it.postId==row.postId&&!it.crop}.sortedBy{it.slot}
                val text=value.postTexts[row.postId]
                require(text==null||text.isNotBlank()&&text.length<=12000&&!Regex("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]").containsMatchIn(text))
                val body=JSONObject().put("version",if(group.type=="PROFILE")3 else if(text==null)1 else 2).apply{if(group.type=="PROFILE"){put("sourceType","PROFILE");put("postText",text?:JSONObject.NULL)}else if(text!=null)put("postText",text)}.put("groupId",group.id).put("row",SavedResultCodec.row(row))
                    .put("photos",JSONArray(photos.map{JSONObject().put("slot",it.slot).put("jpeg",Base64.encodeToString(it.jpeg,Base64.NO_WRAP))})).toString().toByteArray()
                require(body.size<=512*1024)
                val id="mobile-v1:"+AutomationPolicy.digest((device+"/"+group.id+"/"+row.postId+"/").toByteArray()+body)
                val exists=db.rawQuery("SELECT 1 FROM outbox WHERE id=?",arrayOf(id)).use{it.moveToFirst()}
                if(!exists){
                    val ready=OfferQuality.reason(row,photos.size)==null
                    // Incomplete candidates must never consume the delivery capacity.
                    // Keep existing held evidence intact; skip only NEW held snapshots at its own cap.
                    if(!ready&&held>=1000){skippedHeld++;continue}
                    if(ready)check(pending<1000){"QUEUE_FULL"}
                    val values=ContentValues().apply{put("id",id);put("device",device);put("source",group.key);put("post",row.postId);put("saved_at",firstSaved);put("body",seal(id,body));put("state",if(ready)"pending"else"quality_hold")}
                    check(db.insertOrThrow("outbox",null,values)>0)
                    if(ready)pending++ else held++
                }
            }
            if(skippedHeld>0)log("QUALITY_HOLD_LIMIT",skippedHeld)
            db.setTransactionSuccessful()
        } finally {db.endTransaction()}
    }
    data class Item(val id:String,val body:String,val attempt:Int) {override fun toString()="PendingWatcherUpload(redacted)"}
    fun hasDue(device:String,now:Long)=readableDatabase.rawQuery("SELECT 1 FROM outbox WHERE device=? AND state='pending' AND next_at<=? LIMIT 1",arrayOf(device,now.toString())).use{it.moveToFirst()}
    /** First persisted source/post identity, not frozen body variants or retry count. */
    fun newSourceOffers(source:String,since:Long):Int = readableDatabase.rawQuery("SELECT COUNT(*) FROM (SELECT post,MIN(saved_at) AS first_saved FROM outbox WHERE source=? GROUP BY post HAVING COUNT(saved_at)=COUNT(*) AND first_saved>=CAST(? AS INTEGER) AND MAX(CASE WHEN state IN ('pending','sent','blocked') THEN 1 ELSE 0 END)=1)",arrayOf(source,since.toString())).use{it.moveToFirst();it.getInt(0)}
    /** One scan of queue metadata for the whole report; frozen bodies are never opened. */
    fun newSourceOfferCounts(since:Long):Map<String,Int>{
        val counts=mutableMapOf<String,Int>()
        readableDatabase.rawQuery("SELECT source,COUNT(*) FROM (SELECT source,post,MIN(saved_at) AS first_saved FROM outbox WHERE source IS NOT NULL GROUP BY source,post HAVING COUNT(saved_at)=COUNT(*) AND first_saved>=CAST(? AS INTEGER) AND MAX(CASE WHEN state IN ('pending','sent','blocked') THEN 1 ELSE 0 END)=1) GROUP BY source",arrayOf(since.toString())).use{c->while(c.moveToNext())counts[c.getString(0)]=c.getInt(1)}
        return counts
    }
    fun transferCounts():Map<String,Int>{
        val names=mapOf("pending" to "queuePending","blocked" to "queueBlocked","quality_hold" to "queueQualityHeld","sent" to "queueSent")
        val counts=names.values.associateWith{0}.toMutableMap()
        readableDatabase.rawQuery("SELECT state,COUNT(*) FROM outbox GROUP BY state",null).use{c->while(c.moveToNext())names[c.getString(0)]?.let{counts[it]=c.getInt(1).coerceIn(0,100_000_000)}}
        return counts
    }
    fun next(device:String,now:Long):Item? = readableDatabase.rawQuery("SELECT id,body,attempt FROM outbox WHERE device=? AND state='pending' AND next_at<=? ORDER BY rowid LIMIT 1",arrayOf(device,now.toString())).use{
        if(!it.moveToFirst())null else Item(it.getString(0),open(it.getString(0),it.getBlob(1)),it.getInt(2))
    }
    fun hold(item:Item,reason:String){
        require(reason in setOf("PHOTO_REQUIRED","SALE_NOT_CONFIRMED","QUALITY_INVALID"))
        check(writableDatabase.update("outbox",ContentValues().apply{put("state","quality_hold")},"id=?",arrayOf(item.id))==1)
        log(reason)
    }
    fun acknowledge(id:String,receipt:String){
        // Keep encrypted offer/photo snapshots locally along with the durable receipt.
        val values=ContentValues().apply{put("state","sent");put("receipt",receipt)}
        check(writableDatabase.update("outbox",values,"id=?",arrayOf(id))==1)
    }
    fun defer(item:Item,blocked:Boolean=false){
        val values=ContentValues().apply{put("state",if(blocked)"blocked" else "pending");put("attempt",item.attempt+1);put("next_at",System.currentTimeMillis()+AutomationPolicy.retryDelay(item.attempt))}
        check(writableDatabase.update("outbox",values,"id=?",arrayOf(item.id))==1)
    }
    fun retry(){writableDatabase.execSQL("UPDATE outbox SET state='pending',next_at=0,attempt=0 WHERE state NOT IN ('sent','deleted')")}
    fun scanned(slot:String,group:String)=readableDatabase.rawQuery("SELECT 1 FROM scans WHERE slot=? AND source=?",arrayOf(slot,group)).use{it.moveToFirst()}
    fun completeScan(slot:String,group:String){writableDatabase.execSQL("INSERT OR IGNORE INTO scans(slot,source) VALUES(?,?)",arrayOf(slot,group))}
    /** Bounded encrypted diagnostics; never contains post bodies, photos or credentials. */
    fun report(device:String,slot:String,source:String,report:JSONObject){
        val id=report.getString("batchId");val bytes=report.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size<=65536)
        writableDatabase.insertOrThrow("capture_reports",null,ContentValues().apply{put("id",id);put("device",device);put("slot",slot);put("source",source);put("body",seal(id,bytes))})
        writableDatabase.execSQL("DELETE FROM capture_reports WHERE rowid NOT IN (SELECT rowid FROM capture_reports ORDER BY rowid DESC LIMIT 256)")
    }
    fun nextReport(device:String):Item?=readableDatabase.rawQuery("SELECT id,body FROM capture_reports WHERE device=? AND sent=0 ORDER BY rowid LIMIT 1",arrayOf(device)).use{if(!it.moveToFirst())null else Item(it.getString(0),open(it.getString(0),it.getBlob(1)),0)}
    fun reportSent(id:String){writableDatabase.execSQL("UPDATE capture_reports SET sent=1 WHERE id=?",arrayOf(id))}
    fun cycleReports(slot:String):List<JSONObject> = readableDatabase.rawQuery("SELECT id,body FROM capture_reports WHERE rowid IN (SELECT MAX(rowid) FROM capture_reports WHERE slot=? GROUP BY source)",arrayOf(slot)).use{c->buildList{while(c.moveToNext())add(JSONObject(open(c.getString(0),c.getBlob(1))))}}
    fun log(code:String,count:Int=0) {
        require(code.matches(Regex("[A-Z0-9_]{1,60}")))
        writableDatabase.insertOrThrow("journal",null,ContentValues().apply{put("at",System.currentTimeMillis());put("code",code);put("count",count)})
        writableDatabase.execSQL("DELETE FROM journal WHERE id NOT IN (SELECT id FROM journal ORDER BY id DESC LIMIT 200)")
    }
    data class CleanupPreview(val rows:Int,val posts:Int,val pending:Int,val unknownDate:Int)
    fun cleanupPreview(source:String,before:Long):CleanupPreview {
        require(WatcherGroups.find(source)!=null&&before>0&&before<=System.currentTimeMillis())
        val db=readableDatabase
        val counts=db.rawQuery("SELECT COUNT(*),COUNT(DISTINCT post),COALESCE(SUM(CASE WHEN state!='sent' THEN 1 ELSE 0 END),0) FROM outbox WHERE source=? AND state!='deleted' AND saved_at<?",arrayOf(source,before.toString())).use{it.moveToFirst();Triple(it.getInt(0),it.getInt(1),it.getInt(2))}
        val unknown=db.rawQuery("SELECT COUNT(*) FROM outbox WHERE source=? AND state!='deleted' AND saved_at IS NULL",arrayOf(source)).use{it.moveToFirst();it.getInt(0)}
        return CleanupPreview(counts.first,counts.second,counts.third,unknown)
    }
    fun cleanup(source:String,before:Long,expected:CleanupPreview):CleanupPreview {
        val db=writableDatabase;db.beginTransaction()
        try {
            val actual=cleanupPreview(source,before);check(actual==expected){"CLEANUP_CHANGED"}
            db.execSQL("INSERT OR IGNORE INTO removed_posts(source,post) SELECT source,post FROM outbox WHERE source=? AND state!='deleted' AND saved_at<? AND post IS NOT NULL",arrayOf<Any>(source,before))
            // Keep replay keys/receipts, erase the encrypted business payload and stop retries.
            val values=ContentValues().apply{put("state","deleted");put("body",ByteArray(0))}
            db.update("outbox",values,"source=? AND state!='deleted' AND saved_at<?",arrayOf(source,before.toString()))
            db.setTransactionSuccessful();return actual
        }finally{db.endTransaction()}
    }
    fun status():String=buildString {
        appendLine("quality_hold: czekają na potwierdzoną sprzedaż lub przypisane zdjęcie; mają osobny limit i nie blokują wysyłki gotowych ofert. deleted: usunięte dane, zachowany klucz ponowień.")
        readableDatabase.rawQuery("SELECT state,COUNT(*) FROM outbox GROUP BY state",null).use{while(it.moveToNext())appendLine("${it.getString(0)}: ${it.getInt(1)}")}
        readableDatabase.rawQuery("SELECT at,code,count FROM journal ORDER BY id DESC LIMIT 12",null).use{while(it.moveToNext())appendLine("${ScanStatusText.time(it.getLong(0),java.time.ZoneId.systemDefault())}: ${it.getString(1)} (${it.getInt(2)})")}
    }
    companion object {private val KEY_LOCK=Any()}
}
