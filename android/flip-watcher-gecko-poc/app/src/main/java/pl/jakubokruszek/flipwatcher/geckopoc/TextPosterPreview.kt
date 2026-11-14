package pl.jakubokruszek.flipwatcher.geckopoc
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import kotlin.math.*
/** A real captured panel with an explicit caption; no generated property imagery. */
internal object TextPosterPreview {
 fun label(source:Bitmap):Bitmap {
  require(!source.isRecycled&&source.width in 1..192&&source.height in 1..144)
  val width=max(120,source.width);val factor=min(1.0,128.0/source.height)
  val imageWidth=max(1,(source.width*factor).roundToInt());val imageHeight=max(1,(source.height*factor).roundToInt())
  val result=Bitmap.createBitmap(width,imageHeight+16,Bitmap.Config.ARGB_8888)
  val canvas=Canvas(result);canvas.drawColor(Color.rgb(24,24,24))
  val left=(width-imageWidth)/2f
  canvas.drawBitmap(source,null,RectF(left,0f,left+imageWidth,imageHeight.toFloat()),Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
  val paint=Paint(Paint.ANTI_ALIAS_FLAG).apply{color=Color.WHITE;textSize=11f;textAlign=Paint.Align.CENTER}
  canvas.drawText("Plansza tekstowa",width/2f,imageHeight+12f,paint)
  return result
 }
}
