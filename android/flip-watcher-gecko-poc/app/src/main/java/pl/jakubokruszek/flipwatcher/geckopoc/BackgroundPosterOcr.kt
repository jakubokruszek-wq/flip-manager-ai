package pl.jakubokruszek.flipwatcher.geckopoc

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull

/** Automatic local OCR of already exact-bound crops. It cannot replace DOM facts. */
object BackgroundPosterOcr {
    fun merge(row:DesktopRow,ocr:DesktopRow?):DesktopRow {
        if(ocr==null||ocr.postId!=row.postId||ocr.permalink!=row.permalink)return row
        if(row.intent !in setOf("UNKNOWN","SELL_PROPERTY")||row.qualification in setOf("FOREIGN_CITY","CONFLICT","INTENT"))return row
        if(!OfferQuality.confirmedSale(ocr))return row
        if(row.price!=null&&ocr.price!=null&&row.price!=ocr.price||row.area!=null&&ocr.area!=null&&kotlin.math.abs(row.area-ocr.area)>0.05||row.rooms!=null&&ocr.rooms!=null&&row.rooms!=ocr.rooms)return row
        return row.copy(price=row.price?:ocr.price,priceSource=if(row.price!=null)row.priceSource else ocr.priceSource,area=row.area?:ocr.area,rooms=row.rooms?:ocr.rooms,district=row.district?:ocr.district,neighborhood=row.neighborhood?:ocr.neighborhood,street=row.street?:ocr.street,intent="SELL_PROPERTY",usable=true,qualification="CANDIDATE")
    }
    suspend fun run(rows:List<DesktopRow>,alive:()->Boolean,available:(String)->Int,
                    read:suspend(String,Int)->String?,project:suspend(String,List<String>)->DesktopRow?,
                    now:()->Long,progress:(String)->Unit={}):List<DesktopRow> {
        val start=now();var count=0
        val result=rows.toMutableList()
        for((index,row) in rows.withIndex()){
            if(!alive()||now()-start>=45000||count>=20)break
            if(row.intent !in setOf("UNKNOWN","SELL_PROPERTY")||row.qualification in setOf("FOREIGN_CITY","CONFLICT","INTENT"))continue
            if(OfferQuality.confirmedSale(row)&&row.price!=null&&row.area!=null)continue
            val texts=mutableListOf<String>()
            for(slot in 0 until available(row.postId).coerceIn(0,3)){
                if(!alive()||now()-start>=45000||count>=20)break
                count++;progress("OCR")
                val text=try{withTimeoutOrNull((45000-(now()-start)).coerceIn(1,12000)){read(row.postId,slot)}?.take(12000)?.trim()}catch(e:CancellationException){throw e}catch(_:Exception){null}
                if(!text.isNullOrBlank()&&texts.sumOf{it.length}+text.length<=24000)texts.add(text)
            }
            if(texts.isNotEmpty()&&alive()){
                val projected=try{project(row.postId,texts)}catch(e:CancellationException){throw e}catch(_:Exception){null}
                if(alive())result[index]=merge(row,projected)
            }
        }
        return result
    }
}
