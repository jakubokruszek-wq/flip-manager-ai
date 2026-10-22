package pl.jakubokruszek.flipwatcher.geckopoc

import android.graphics.Bitmap
import android.view.InputDevice
import android.view.MotionEvent
import org.json.JSONObject
import org.mozilla.geckoview.GeckoView
import kotlin.math.*

/** Strict metadata only. No image URL, cookies, text or media IDs cross this boundary. */
object DesktopViewportProtocol {
    data class Tile(val postId:String,val slot:Int,val x:Double,val y:Double,val width:Double,val height:Double)
    data class Request(val requestId:String,val action:String,val width:Double=0.0,val height:Double=0.0,val tiles:List<Tile> = emptyList(),val x:Double=0.0,val y:Double=0.0,val frameId:String?=null)
    fun parse(j:JSONObject,nonce:String):Request?=runCatching {
        val base=setOf("type","nonce","requestId","action")
        if(j.opt("type")!="desktopViewportRequest"||j.opt("nonce")!=nonce)return null
        val id=j.getString("requestId");if(java.util.UUID.fromString(id).toString()!=id)return null
        fun num(o:JSONObject,k:String,min:Double,max:Double):Double {val v=o.get(k);require(v is Number);val n=v.toDouble();require(n.isFinite()&&n in min..max);return n}
        when(j.getString("action")){
            "commit","drop"->{if(j.keys().asSequence().toSet()!=base+"frameId")return null
                val frame=j.getString("frameId");if(java.util.UUID.fromString(frame).toString()!=frame)return null
                Request(id,j.getString("action"),frameId=frame)}
            "scroll"->{if(j.keys().asSequence().toSet()!=base+setOf("x","y"))return null
                Request(id,"scroll",x=num(j,"x",0.1,0.9),y=num(j,"y",0.1,0.9))}
            "photos"->{if(j.keys().asSequence().toSet()!=base+setOf("width","height","tiles"))return null
                val w=num(j,"width",100.0,10000.0);val h=num(j,"height",100.0,10000.0)
                val a=j.getJSONArray("tiles");if(a.length() !in 1..3)return null
                val seen=HashSet<String>();val tiles=(0 until a.length()).map{i->val t=a.getJSONObject(i)
                    if(t.keys().asSequence().toSet()!=setOf("postId","slot","x","y","width","height"))return null
                    val post=t.getString("postId");if(!Regex("[0-9]{5,30}").matches(post)||t.opt("slot") !is Int||t.getInt("slot") !in 0..2||!seen.add("$post:${t.getInt("slot")}"))return null
                    val x=num(t,"x",0.0,w);val y=num(t,"y",0.0,h);val tw=num(t,"width",60.0,w);val th=num(t,"height",60.0,h)
                    if(x+tw>w+0.01||y+th>h+0.01)return null
                    Tile(post,t.getInt("slot"),x,y,tw,th)
                };Request(id,"photos",w,h,tiles)
            }
            else->null
        }
    }.getOrNull()
}

/** Bounded RAM ownership. Never encode, persist, log or copy bitmaps. */
class DesktopThumbnails {
    private val images=LinkedHashMap<String,MutableMap<Int,Bitmap>>()
    fun rows(id:String):List<Bitmap> = images[id]?.toSortedMap()?.values?.toList()?:emptyList()
    val count:Int get()=images.values.sumOf{it.size}
    fun put(id:String,slot:Int,image:Bitmap):Boolean {
        if(slot !in 0..2||!Regex("[0-9]{5,30}").matches(id)||image.isRecycled||image.width>192||image.height>144||!images.containsKey(id)&&images.size>=20){image.recycle();return false}
        val slots=images.getOrPut(id){linkedMapOf()};if(slots.containsKey(slot)){image.recycle();return false};slots[slot]=image;return true
    }
    fun retain(ids:Set<String>){for(id in images.keys.toList())if(id !in ids)images.remove(id)?.values?.forEach{it.recycle()}}
    fun clear(){images.values.flatMap{it.values}.forEach{it.recycle()};images.clear()}
    override fun toString()="DesktopThumbnails(redacted)"
}

/** Official GeckoView wheel input and rendered-pixel crops, under the same live native gate. */
class DesktopViewportBridge(private val view:GeckoView,private val nonce:String,private val images:DesktopThumbnails,
                            private val live:()->Boolean,private val now:()->Long={android.os.SystemClock.elapsedRealtime()}) {
    private var closed=false;private var busy=false;private var captures=0;private var scrolls=0;private var lastScroll=Long.MIN_VALUE
    private val requests=HashSet<String>()
    private var pendingFrame:String?=null;private var pendingAt=0L
    private var pendingCrops:List<Pair<DesktopViewportProtocol.Tile,Bitmap>> = emptyList()
    private fun discard(){pendingCrops.forEach{if(!it.second.isRecycled)it.second.recycle()};pendingCrops=emptyList();pendingFrame=null}
    fun close(){closed=true;discard()}
    private fun active()=!closed&&live()&&view.isShown&&view.hasWindowFocus()&&view.width>=100&&view.height>=100
    fun handle(j:JSONObject,reply:(JSONObject)->Unit){
        val r=DesktopViewportProtocol.parse(j,nonce)?:return
        fun ack(ok:Boolean,count:Int=0){if(!closed)reply(JSONObject().put("type","desktopViewportAck").put("nonce",nonce).put("requestId",r.requestId).put("accepted",ok).put("count",count))}
        if(!active()||busy||requests.size>=90||!requests.add(r.requestId)){ack(false);return}
        if(pendingFrame!=null&&now()-pendingAt>1000)discard()
        if(r.action in setOf("commit","drop")){
            if(r.frameId!=pendingFrame){ack(false);return}
            if(r.action=="drop"){discard();ack(true);return}
            val count=pendingCrops.size
            for((t,b) in pendingCrops)images.put(t.postId,t.slot,b)
            pendingCrops=emptyList();pendingFrame=null;ack(true,count);return
        }
        if(pendingFrame!=null){ack(false);return}
        if(r.action=="scroll"){
            if(scrolls>=30||lastScroll!=Long.MIN_VALUE&&now()-lastScroll<700){ack(false);return}
            val stamp=now();val props=MotionEvent.PointerProperties().apply{id=0;toolType=MotionEvent.TOOL_TYPE_MOUSE}
            val coords=MotionEvent.PointerCoords().apply{x=(view.width*r.x).toFloat();y=(view.height*r.y).toFloat();setAxisValue(MotionEvent.AXIS_VSCROLL,-6f)}
            val eventStamp=android.os.SystemClock.uptimeMillis()
            val event=MotionEvent.obtain(eventStamp,eventStamp,MotionEvent.ACTION_SCROLL,1,arrayOf(props),arrayOf(coords),0,0,1f,1f,0,0,InputDevice.SOURCE_MOUSE,0)
            try{if(!active()){ack(false);return};view.onGenericMotionEvent(event);scrolls++;lastScroll=stamp;ack(true)}finally{event.recycle()}
            return
        }
        if(captures>=20||abs((r.width/r.height)/(view.width.toDouble()/view.height)-1)>0.005){ack(false);return}
        busy=true;captures++;val started=now()
        try{view.capturePixels().accept({frame->
            try{
                if(frame==null||!active()||now()-started>800||frame.width!=view.width||frame.height!=view.height||frame.width.toLong()*frame.height>4_000_000){ack(false);return@accept}
                val crops=ArrayList<Pair<DesktopViewportProtocol.Tile,Bitmap>>()
                try{
                    for(t in r.tiles){
                        val x=floor(t.x/r.width*frame.width).toInt()+2;val y=floor(t.y/r.height*frame.height).toInt()+2
                        val right=floor((t.x+t.width)/r.width*frame.width).toInt().coerceAtMost(frame.width)-2;val bottom=floor((t.y+t.height)/r.height*frame.height).toInt().coerceAtMost(frame.height)-2
                        if(x<0||y<0||right<=x||bottom<=y)throw IllegalArgumentException("crop")
                        val crop=Bitmap.createBitmap(frame,x,y,right-x,bottom-y);val factor=min(192.0/crop.width,144.0/crop.height).coerceAtMost(1.0)
                        val small=Bitmap.createScaledBitmap(crop,max(1,(crop.width*factor).toInt()),max(1,(crop.height*factor).toInt()),true)
                        val owned=if(small===frame||small===crop)requireNotNull(small.copy(Bitmap.Config.ARGB_8888,false)) else small
                        if(crop!==frame&&crop!==owned)crop.recycle();crops.add(t to owned)
                    }
                    if(!active()||now()-started>800){ack(false);return@accept}
                    // The entire frame is transient; only already-visible image rectangles survive.
                    pendingCrops=crops.toList();pendingFrame=r.requestId;pendingAt=now();crops.clear();ack(true,r.tiles.size)
                }finally{for((_,b) in crops)if(!b.isRecycled)b.recycle()}
            }catch(_:Exception){ack(false)}finally{frame?.recycle();busy=false}
        },{busy=false;ack(false)})}catch(_:Exception){busy=false;ack(false)}
    }
}
