package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.HttpsURLConnection

/** Deliberately separate from Facebook: no browser cookies, page bodies, photos or OCR are sent. */
object WatcherLink {
    const val ORIGIN="https://flip-manager-ai.vercel.app"
    private const val KEY="watcher-device-link-v1"
    private val aad="flip-watcher/device-link/v1".toByteArray()
    class Credentials(val deviceId:String,val token:String){override fun toString()="WatcherCredentials(redacted)"}
    fun parsePairing(raw:String):Credentials {
        require(raw.length in 1..4096)
        val j=JSONObject(raw)
        require(j.keys().asSequence().toSet()==setOf("apiUrl","deviceId","deviceToken"))
        require(j.getString("apiUrl")==ORIGIN)
        val id=j.getString("deviceId");require(java.util.UUID.fromString(id).toString()==id)
        val token=j.getString("deviceToken");require(Regex("[A-Za-z0-9_-]{32,128}").matches(token))
        return Credentials(id,token)
    }
    /** Validated exact group identities; a feed must describe the complete active group set. */
    fun parseGroups(raw:String):List<WatcherGroup>{
        require(raw.length<=128*1024)
        val j=JSONObject(raw);require(j.getInt("version")==1)
        val a=j.getJSONArray("groups");require(a.length()<=200)
        val groups=(0 until a.length()).map{index->
            val row=a.getJSONObject(index);val id=row.getString("groupId")
            require(WatcherGroups.find(id)!=null) // This release supports the reviewed eleven sources.
            require(row.getString("url")=="https://www.facebook.com/groups/$id/")
            val name=row.getString("name");require(name.isNotBlank()&&name.length<=500)
            WatcherGroup(id,name)
        }
        require(groups.map{it.id}.toSet().size==groups.size)
        return groups
    }
    /** Fixed origin + fixed read-only paths, redirects disabled: a pairing code cannot choose a token destination. */
    private fun get(path:String,credentials:Credentials):String {
        require(path in setOf("/api/collector/devices/current","/api/collector/facebook/groups"))
        val connection=URL(ORIGIN+path).openConnection() as HttpsURLConnection
        try {
            connection.instanceFollowRedirects=false;connection.connectTimeout=10000;connection.readTimeout=15000
            connection.useCaches=false;connection.setRequestProperty("Accept","application/json")
            connection.setRequestProperty("Authorization","Bearer "+credentials.token)
            val status=connection.responseCode
            if(status==401)error("WATCHER_PAIRING_REQUIRED")
            if(status!=200)error("WATCHER_UNAVAILABLE")
            val data=connection.inputStream.use{readBounded(it,128*1024)}
            require(data.size<=128*1024);return String(data,Charsets.UTF_8)
        }finally{connection.disconnect()}
    }
    fun groups(credentials:Credentials,verifyDevice:Boolean=false):List<WatcherGroup>{
        if(verifyDevice){val j=JSONObject(get("/api/collector/devices/current",credentials));require(j.optBoolean("connected")&&j.getString("deviceId")==credentials.deviceId&&!j.optBoolean("revoked",true))}
        return parseGroups(get("/api/collector/facebook/groups",credentials))
    }
    private fun readBounded(input:java.io.InputStream,limit:Int):ByteArray {
        val out=java.io.ByteArrayOutputStream();val buffer=ByteArray(4096)
        while(true){val count=input.read(buffer);if(count<0)break;require(out.size()+count<=limit);out.write(buffer,0,count)}
        return out.toByteArray()
    }
    private fun key():SecretKey {
        val store=KeyStore.getInstance("AndroidKeyStore").apply{load(null)}
        (store.getKey(KEY,null) as? SecretKey)?.let{return it}
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply{
            init(KeyGenParameterSpec.Builder(KEY,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun file(context:Context)=AtomicFile(File(context.noBackupFilesDir,"watcher-link-v1.bin"))
    fun save(context:Context,value:Credentials){
        val json=JSONObject().put("apiUrl",ORIGIN).put("deviceId",value.deviceId).put("deviceToken",value.token).toString()
        parsePairing(json)
        val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply{init(Cipher.ENCRYPT_MODE,key());updateAAD(aad)}
        val target=file(context);val output=target.startWrite()
        try{output.write(cipher.iv);output.write(cipher.doFinal(json.toByteArray()));target.finishWrite(output)}
        catch(e:Exception){target.failWrite(output);throw e}
    }
    fun load(context:Context):Credentials? {
        val target=file(context);if(!target.baseFile.exists()&&!File(target.baseFile.path+".bak").exists())return null
        val bytes=target.openRead().use{readBounded(it,8192)};require(bytes.size in 29..8192)
        val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply{init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,bytes.copyOfRange(0,12)));updateAAD(aad)}
        return parsePairing(String(cipher.doFinal(bytes.copyOfRange(12,bytes.size)),Charsets.UTF_8))
    }
    fun forget(context:Context)=file(context).delete()
}
