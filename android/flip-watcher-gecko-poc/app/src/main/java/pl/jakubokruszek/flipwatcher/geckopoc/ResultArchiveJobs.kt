package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import java.util.concurrent.Executors

/** Serial disk queue survives Activity pause/destruction. It never opens a browser or runs OCR. */
object ResultArchiveJobs {
    private val worker=Executors.newSingleThreadExecutor{r->Thread(r,"saved-search").apply{isDaemon=true}}
    private val main=Handler(Looper.getMainLooper())
    private data class OwnedPhoto(val id:String,val slot:Int,val crop:Boolean,val bitmap:Bitmap)
    suspend fun read(context:Context):Result<SavedResult?> = kotlinx.coroutines.suspendCancellableCoroutine{continuation->
        load(context){value->if(continuation.isActive)continuation.resumeWith(Result.success(value))}
    }
    fun load(context:Context,done:(Result<SavedResult?>)->Unit){val app=context.applicationContext
        worker.execute{val result=runCatching{ResultArchive(app).load()};main.post{done(result)}}
    }
    fun save(context:Context,rows:List<DesktopRow>,ocr:List<DesktopRow>,images:DesktopThumbnails?,replacePhotos:Boolean=false,done:(Boolean)->Unit){
        if(rows.isEmpty())return
        val app=context.applicationContext;val copies=mutableListOf<OwnedPhoto>()
        // Copy bounded pixel ownership before the Activity is allowed to recycle its cache.
        try{if(images!=null)for(row in rows){
            for((slot,b) in images.rows(row.postId).withIndex())copies+=OwnedPhoto(row.postId,slot,false,checkNotNull(b.copy(Bitmap.Config.ARGB_8888,false)))
            for((slot,b) in images.ocrRows(row.postId).withIndex())copies+=OwnedPhoto(row.postId,slot,true,checkNotNull(b.copy(Bitmap.Config.ARGB_8888,false)))
        }}catch(_:Exception){copies.forEach{it.bitmap.recycle()};done(false);return}
        val timestamp=System.currentTimeMillis()
        worker.execute{
            val success=try{
                val store=ResultArchive(app)
                val previous=if(!replacePhotos)store.load() else null
                val ids=rows.map{it.postId}.toSet()
                val incoming=copies.map{ResultArchive.photo(it.id,it.slot,it.crop,it.bitmap)}
                val keys=incoming.map{Triple(it.postId,it.slot,it.crop)}.toSet()
                val retained=previous?.photos.orEmpty().filter{it.postId in ids&&Triple(it.postId,it.slot,it.crop) !in keys}
                val photos=(retained+incoming).filter{!it.crop}+(incoming+retained).filter{it.crop}.take(20)
                store.save(SavedResult(timestamp,rows.toList(),ocr.toList(),photos))
            }catch(_:Exception){false}finally{copies.forEach{if(!it.bitmap.isRecycled)it.bitmap.recycle()}}
            main.post{done(success)}
        }
    }
    fun delete(context:Context,done:(Boolean)->Unit){val app=context.applicationContext
        // FIFO: every earlier save finishes before deletion. No queued write can resurrect it.
        worker.execute{val ok=runCatching{ResultArchive(app).delete()}.isSuccess;main.post{done(ok)}}
    }
}
