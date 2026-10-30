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
class WatcherOutbox(context:Context):SQLiteOpenHelper(context,"watcher-outbox-v1.db",null,1) {
    override fun onCreate(db:SQLiteDatabase) {
        db.execSQL("CREATE TABLE outbox (id TEXT PRIMARY KEY, device TEXT NOT NULL, body BLOB NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempt INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, receipt TEXT)")
        db.execSQL("CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, code TEXT NOT NULL, count INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE scans (slot TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(slot, source))")
    }
    override fun onUpgrade(db:SQLiteDatabase,old:Int,new:Int)=error("Unsupported queue version")
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
                val photos=value.photos.filter{it.postId==row.postId&&!it.crop}.sortedBy{it.slot}
                val body=JSONObject().put("version",1).put("groupId",group.id).put("row",SavedResultCodec.row(row))
                    .put("photos",JSONArray(photos.map{JSONObject().put("slot",it.slot).put("jpeg",Base64.encodeToString(it.jpeg,Base64.NO_WRAP))})).toString().toByteArray()
                require(body.size<=512*1024)
                val id="mobile-v1:"+AutomationPolicy.digest((device+"/"+group.id+"/"+row.postId+"/").toByteArray()+body)
                val values=ContentValues().apply{put("id",id);put("device",device);put("body",seal(id,body))}
                val exists=db.rawQuery("SELECT 1 FROM outbox WHERE id=?",arrayOf(id)).use{it.moveToFirst()}
                if(!exists){
                    check(db.rawQuery("SELECT COUNT(*) FROM outbox WHERE state!='sent'",null).use{it.moveToFirst();it.getInt(0)}<1000){"QUEUE_FULL"}
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
    fun acknowledge(id:String,receipt:String){
        // Keep encrypted offer/photo snapshots locally along with the durable receipt.
        val values=ContentValues().apply{put("state","sent");put("receipt",receipt)}
        check(writableDatabase.update("outbox",values,"id=?",arrayOf(id))==1)
    }
    fun defer(item:Item,blocked:Boolean=false){
        val values=ContentValues().apply{put("state",if(blocked)"blocked" else "pending");put("attempt",item.attempt+1);put("next_at",System.currentTimeMillis()+AutomationPolicy.retryDelay(item.attempt))}
        check(writableDatabase.update("outbox",values,"id=?",arrayOf(item.id))==1)
    }
    fun retry(){writableDatabase.execSQL("UPDATE outbox SET state='pending',next_at=0,attempt=0 WHERE state!='sent'")}
    fun scanned(slot:String,group:String)=readableDatabase.rawQuery("SELECT 1 FROM scans WHERE slot=? AND source=?",arrayOf(slot,group)).use{it.moveToFirst()}
    fun completeScan(slot:String,group:String){writableDatabase.execSQL("INSERT OR IGNORE INTO scans(slot,source) VALUES(?,?)",arrayOf(slot,group))}
    fun log(code:String,count:Int=0) {
        require(code.matches(Regex("[A-Z0-9_]{1,60}")))
        writableDatabase.insertOrThrow("journal",null,ContentValues().apply{put("at",System.currentTimeMillis());put("code",code);put("count",count)})
        writableDatabase.execSQL("DELETE FROM journal WHERE id NOT IN (SELECT id FROM journal ORDER BY id DESC LIMIT 200)")
    }
    fun status():String=buildString {
        readableDatabase.rawQuery("SELECT state,COUNT(*) FROM outbox GROUP BY state",null).use{while(it.moveToNext())appendLine("${it.getString(0)}: ${it.getInt(1)}")}
        readableDatabase.rawQuery("SELECT at,code,count FROM journal ORDER BY id DESC LIMIT 12",null).use{while(it.moveToNext())appendLine("${java.time.Instant.ofEpochMilli(it.getLong(0))}: ${it.getString(1)} (${it.getInt(2)})")}
    }
    companion object {private val KEY_LOCK=Any()}
}
