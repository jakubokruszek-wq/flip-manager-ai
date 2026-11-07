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
class WatcherOutbox(context:Context):SQLiteOpenHelper(context,"watcher-outbox-v1.db",null,3) {
    override fun onCreate(db:SQLiteDatabase) {
        db.execSQL("CREATE TABLE outbox (id TEXT PRIMARY KEY, device TEXT NOT NULL, body BLOB NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempt INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, receipt TEXT, source TEXT, post TEXT, saved_at INTEGER)")
        db.execSQL("CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, code TEXT NOT NULL, count INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE scans (slot TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(slot, source))")
        db.execSQL("CREATE TABLE removed_posts (source TEXT NOT NULL, post TEXT NOT NULL, PRIMARY KEY(source,post))")
        db.execSQL("CREATE TABLE scan_failures (slot TEXT NOT NULL, source TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(slot,source))")
    }
    override fun onUpgrade(db:SQLiteDatabase,old:Int,new:Int){
        check(old in 1..2&&new==3)
        if(old==2){
            db.execSQL("CREATE TABLE scan_failures (slot TEXT NOT NULL, source TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(slot,source))")
            return
        }
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
        db.execSQL("CREATE TABLE scan_failures (slot TEXT NOT NULL, source TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(slot,source))")
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
        require(SavedResultCodec.rows(JSONArray(value.rows.map(SavedResultCodec::row)),group.id)==value.rows)
        val db=writableDatabase;db.beginTransaction()
        try {
            for(row in value.rows) {
                if(db.rawQuery("SELECT 1 FROM removed_posts WHERE source=? AND post=?",arrayOf(group.id,row.postId)).use{it.moveToFirst()})continue
                val firstSaved=db.rawQuery("SELECT MIN(saved_at) FROM outbox WHERE source=? AND post=?",arrayOf(group.id,row.postId)).use{if(it.moveToFirst()&&!it.isNull(0))it.getLong(0)else value.savedAt}
                val photos=value.photos.filter{it.postId==row.postId&&!it.crop}.sortedBy{it.slot}
                val body=JSONObject().put("version",1).put("groupId",group.id).put("row",SavedResultCodec.row(row))
                    .put("photos",JSONArray(photos.map{JSONObject().put("slot",it.slot).put("jpeg",Base64.encodeToString(it.jpeg,Base64.NO_WRAP))})).toString().toByteArray()
                require(body.size<=512*1024)
                val id="mobile-v1:"+AutomationPolicy.digest((device+"/"+group.id+"/"+row.postId+"/").toByteArray()+body)
                val values=ContentValues().apply{put("id",id);put("device",device);put("source",group.id);put("post",row.postId);put("saved_at",firstSaved);put("body",seal(id,body));put("state",if(OfferQuality.reason(row,photos.size)==null)"pending"else"quality_hold")}
                val exists=db.rawQuery("SELECT 1 FROM outbox WHERE id=?",arrayOf(id)).use{it.moveToFirst()}
                if(!exists){
                    check(db.rawQuery("SELECT COUNT(*) FROM outbox WHERE state NOT IN ('sent','deleted')",null).use{it.moveToFirst();it.getInt(0)}<1000){"QUEUE_FULL"}
                    check(db.insertOrThrow("outbox",null,values)>0)
                }
            }
            db.setTransactionSuccessful()
        } finally {db.endTransaction()}
    }
    data class Item(val id:String,val body:String,val attempt:Int) {override fun toString()="PendingWatcherUpload(redacted)"}
    fun hasDue(device:String,now:Long)=readableDatabase.rawQuery("SELECT 1 FROM outbox WHERE device=? AND state='pending' AND next_at<=? LIMIT 1",arrayOf(device,now.toString())).use{it.moveToFirst()}
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
    /** Persist failures across worker retries. A permanently failing group must not cause an infinite retry loop. */
    fun failureCount(slot:String,group:String):Int=readableDatabase.rawQuery("SELECT attempts FROM scan_failures WHERE slot=? AND source=?",arrayOf(slot,group)).use{if(it.moveToFirst())it.getInt(0)else 0}
    fun recordScanFailure(slot:String,group:String):Int {
        val db=writableDatabase
        db.execSQL("INSERT OR IGNORE INTO scan_failures(slot,source,attempts) VALUES(?,?,0)",arrayOf(slot,group))
        db.execSQL("UPDATE scan_failures SET attempts=attempts+1 WHERE slot=? AND source=?",arrayOf(slot,group))
        return failureCount(slot,group)
    }
    fun scanned(slot:String,group:String)=readableDatabase.rawQuery("SELECT 1 FROM scans WHERE slot=? AND source=?",arrayOf(slot,group)).use{it.moveToFirst()}
    fun completeScan(slot:String,group:String){writableDatabase.execSQL("INSERT OR IGNORE INTO scans(slot,source) VALUES(?,?)",arrayOf(slot,group));writableDatabase.delete("scan_failures","slot=? AND source=?",arrayOf(slot,group))}
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
        appendLine("quality_hold: czekają na potwierdzoną sprzedaż lub przypisane zdjęcie. deleted: usunięte dane, zachowany klucz ponowień.")
        readableDatabase.rawQuery("SELECT state,COUNT(*) FROM outbox GROUP BY state",null).use{while(it.moveToNext())appendLine("${it.getString(0)}: ${it.getInt(1)}")}
        readableDatabase.rawQuery("SELECT at,code,count FROM journal ORDER BY id DESC LIMIT 12",null).use{while(it.moveToNext())appendLine("${java.time.Instant.ofEpochMilli(it.getLong(0))}: ${it.getString(1)} (${it.getInt(2)})")}
    }
    companion object {private val KEY_LOCK=Any()}
}
