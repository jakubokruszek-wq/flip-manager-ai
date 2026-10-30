package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Historical data only: loading this file never restores a browser grant or document proof. */
data class SavedResult(val savedAt:Long,val rows:List<DesktopRow>,val ocr:List<DesktopRow>,val photos:List<SavedPhoto>)
data class SavedPhoto(val postId:String,val slot:Int,val crop:Boolean,val jpeg:ByteArray)

/** Strict typed-row codec shared with the browser protocol, without manufacturing live proof. */
object SavedResultCodec {
    fun row(r:DesktopRow)=JSONObject().apply {
        put("postId",r.postId);put("permalink",r.permalink);put("layer",r.layer)
        put("price",r.price?:JSONObject.NULL);put("priceSource",r.priceSource);put("area",r.area?:JSONObject.NULL)
        put("rooms",r.rooms?:JSONObject.NULL);put("district",r.district?:JSONObject.NULL)
        put("neighborhood",r.neighborhood?:JSONObject.NULL);put("street",r.street?:JSONObject.NULL)
        put("intent",r.intent);put("usable",r.usable);put("photos",r.photos);put("qualification",r.qualification)
    }
    fun rows(a:JSONArray,groupId:String=PocPolicy.APPROVED_GROUP_ID):List<DesktopRow>? {
        // This is validation of persisted DTOs, not authorization for any browser operation.
        val stats=JSONObject(DesktopProtocol.emptyStats()).put("verified",1).put("candidates",a.length())
        return DesktopProtocol.parse(JSONObject().put("type","desktopPreviewResult").put("nonce","archive")
            .put("status","OK").put("reason","DONE").put("stats",stats).put("rows",a),"archive",groupId)?.rows
    }
    fun metadata(value:SavedResult,groupId:String=PocPolicy.APPROVED_GROUP_ID):ByteArray {
        require(value.savedAt>0&&rows(JSONArray(value.rows.map(::row)),groupId)==value.rows)
        require(rows(JSONArray(value.ocr.map(::row)),groupId)==value.ocr&&value.ocr.all{o->value.rows.any{it.postId==o.postId&&it.permalink==o.permalink}})
        return JSONObject().put("version",1).put("savedAt",value.savedAt).put("rows",JSONArray(value.rows.map(::row)))
            .put("ocr",JSONArray(value.ocr.map(::row))).toString().toByteArray(Charsets.UTF_8)
    }
}

/** Atomic, private, encrypted last result. Empty/error runs cannot erase the last good result. */
class ResultArchive(context:Context,private val groupId:String=PocPolicy.APPROVED_GROUP_ID) {
    private val file=AtomicFile(File(context.noBackupFilesDir,WatcherGroups.archiveFile(groupId)))
    private fun key():SecretKey {
        val store=KeyStore.getInstance("AndroidKeyStore").apply{load(null)}
        (store.getKey(KEY,null) as? SecretKey)?.let{return it}
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply{
            init(KeyGenParameterSpec.Builder(KEY,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun save(value:SavedResult):Boolean=synchronized(lock) {
        if(value.rows.isEmpty())return false
        var stream:FileOutputStream?=null
        try {
            val metadata=SavedResultCodec.metadata(value,groupId)
            require(metadata.size<=128*1024&&value.photos.size<=80&&value.photos.sumOf{it.jpeg.size.toLong()}<=MAX_PHOTO_BYTES)
            val ids=value.rows.map{it.postId}.toSet();val seen=HashSet<String>()
            for(p in value.photos)require(p.postId in ids&&p.slot in 0..2&&p.jpeg.size in 1..MAX_IMAGE_BYTES&&seen.add("${p.postId}/${p.slot}/${p.crop}"))
            val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply{init(Cipher.ENCRYPT_MODE,key());updateAAD(AAD)}
            stream=file.startWrite();stream.write(byteArrayOf(1));stream.write(cipher.iv)
            val borrowed=object:FilterOutputStream(stream){override fun close(){flush()}}
            DataOutputStream(javax.crypto.CipherOutputStream(borrowed,cipher)).use{out->
                out.writeInt(metadata.size);out.write(metadata);out.writeInt(value.photos.size)
                for(p in value.photos){
                    out.writeUTF(p.postId);out.writeInt(p.slot);out.writeBoolean(p.crop);out.writeInt(p.jpeg.size);out.write(p.jpeg)}
            }
            file.finishWrite(stream);true
        }catch(_:Exception){stream?.let{file.failWrite(it)};false}
    }
    fun load():SavedResult?=synchronized(lock) {
        if(!file.baseFile.exists()&&!File(file.baseFile.path+".bak").exists())return null
        val source=file.openRead()
        try {
        require(source.channel.size()<=MAX_FILE_BYTES)
        val header=DataInputStream(source);require(header.readUnsignedByte()==1);val iv=ByteArray(12);header.readFully(iv)
        val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply{init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,iv));updateAAD(AAD)}
        DataInputStream(javax.crypto.CipherInputStream(source,cipher)).use{input->
            val size=input.readInt();require(size in 1..128*1024)
            val metadata=ByteArray(size);input.readFully(metadata);val j=JSONObject(String(metadata,Charsets.UTF_8))
            require(j.keys().asSequence().toSet()==setOf("version","savedAt","rows","ocr")&&j.getInt("version")==1&&j.getLong("savedAt")>0)
            val rows=SavedResultCodec.rows(j.getJSONArray("rows"),groupId)?:error("ARCHIVE_ROWS")
            val ocr=SavedResultCodec.rows(j.getJSONArray("ocr"),groupId)?:error("ARCHIVE_OCR")
            require(rows.isNotEmpty()&&ocr.all{o->rows.any{it.postId==o.postId&&it.permalink==o.permalink}})
            val count=input.readInt();require(count in 0..80);var total=0L;val seen=HashSet<String>()
            val photos=(0 until count).map{
                val id=input.readUTF();val slot=input.readInt();val crop=input.readBoolean();val length=input.readInt()
                require(rows.any{it.postId==id}&&slot in 0..2&&length in 1..MAX_IMAGE_BYTES&&seen.add("$id/$slot/$crop"))
                total+=length;require(total<=MAX_PHOTO_BYTES);val data=ByteArray(length);input.readFully(data)
                val bounds=BitmapFactory.Options().apply{inJustDecodeBounds=true};BitmapFactory.decodeByteArray(data,0,data.size,bounds)
                require(bounds.outWidth in 1..(if(crop)1024 else 192)&&bounds.outHeight in 1..(if(crop)1024 else 144))
                SavedPhoto(id,slot,crop,data)
            };require(input.read()==-1);SavedResult(j.getLong("savedAt"),rows,ocr,photos)
        }
        }finally{source.close()}
    }
    fun delete()=synchronized(lock){file.delete();check(!file.baseFile.exists()&&!File(file.baseFile.path+".bak").exists())}
    companion object {
        private val lock=Any()
        private const val KEY="saved-search-v1"
        private val AAD="flip-watcher/saved-search/v1".toByteArray(Charsets.UTF_8)
        private const val MAX_IMAGE_BYTES=4*1024*1024
        private const val MAX_PHOTO_BYTES=16L*1024*1024
        private const val MAX_FILE_BYTES=17*1024*1024
        fun photo(id:String,slot:Int,crop:Boolean,image:Bitmap):SavedPhoto {
            require(!image.isRecycled)
            val out=ByteArrayOutputStream();check(image.compress(Bitmap.CompressFormat.JPEG,90,out))
            return SavedPhoto(id,slot,crop,out.toByteArray())
        }
    }
}
