package pl.jakubokruszek.flipwatcher.geckopoc

import android.graphics.Bitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

/** Bounded thumbnail JPEG work runs off the UI thread. The caller has closed its
 * viewport bridge and completed OCR, so these owned bitmaps cannot change during encoding.
 * This short CPU-only block must finish before caller cleanup recycles them. */
internal object BackgroundPhotoEncoding {
    suspend fun encode(rows:List<DesktopRow>,images:DesktopThumbnails,
                       encoder:(String,Int,Bitmap)->SavedPhoto={id,slot,b->ResultArchive.photo(id,slot,false,b)}):List<SavedPhoto> =
        withContext(Dispatchers.Default+NonCancellable) {
            require(rows.size<=50)
            // ML Kit owns independent copies; large retained OCR crops are no
            // longer needed. Keep only the small transfer images during JPEG work.
            images.clearOcr()
            rows.flatMap{row->images.rows(row.postId).mapIndexed{slot,b->encoder(row.postId,slot,b)}}
        }
}
