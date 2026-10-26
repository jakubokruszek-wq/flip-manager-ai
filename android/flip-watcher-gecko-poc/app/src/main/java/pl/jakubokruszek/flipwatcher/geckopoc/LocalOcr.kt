package pl.jakubokruszek.flipwatcher.geckopoc

import android.graphics.Bitmap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Bundled Latin model, no download/cloud API. Takes bitmap ownership, even on cancellation. */
object LocalOcr{
 private val active=java.util.concurrent.atomic.AtomicBoolean(false)
 suspend fun readOwned(bitmap:Bitmap):String=suspendCancellableCoroutine{continuation->
  if(!active.compareAndSet(false,true)){if(!bitmap.isRecycled)bitmap.recycle();continuation.resumeWithException(IllegalStateException("OCR_BUSY"));return@suspendCancellableCoroutine}
  val client=try{TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)}catch(_:Exception){if(!bitmap.isRecycled)bitmap.recycle();active.set(false);continuation.resumeWithException(IllegalStateException("OCR_FAILED"));return@suspendCancellableCoroutine}
  try{client.process(InputImage.fromBitmap(bitmap,0)).addOnCompleteListener{task->
   val value=runCatching{if(task.isSuccessful)task.result.text.take(12000) else null}.getOrNull()
   if(!bitmap.isRecycled)bitmap.recycle();runCatching{client.close()};active.set(false)
   if(continuation.isActive){if(value!=null)continuation.resume(value) else continuation.resumeWithException(IllegalStateException("OCR_FAILED"))}
  }}catch(e:Exception){if(!bitmap.isRecycled)bitmap.recycle();runCatching{client.close()};active.set(false);if(continuation.isActive)continuation.resumeWithException(IllegalStateException("OCR_FAILED"))}
  // Cancelling never recycles a bitmap while ML Kit is still reading it. Its task owns cleanup.
 }
}
