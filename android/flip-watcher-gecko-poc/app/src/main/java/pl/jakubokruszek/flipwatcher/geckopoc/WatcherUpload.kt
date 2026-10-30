package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/** Fixed Manager origin only. No redirects, browser cookies, source responses or logs. */
object WatcherUpload {
    class HttpFailure(val status:Int):Exception("WATCHER_HTTP_$status")
    fun send(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item):String {
        val connection=URL(WatcherLink.ORIGIN+"/api/collector/facebook/mobile").openConnection() as HttpsURLConnection
        try {
            connection.instanceFollowRedirects=false;connection.connectTimeout=10_000;connection.readTimeout=30_000
            connection.requestMethod="POST";connection.doOutput=true;connection.useCaches=false
            connection.setRequestProperty("Authorization","Bearer "+credentials.token)
            connection.setRequestProperty("Content-Type","application/json")
            connection.setRequestProperty("Idempotency-Key",item.id)
            val bytes=item.body.toByteArray(Charsets.UTF_8);require(bytes.size<=512*1024)
            connection.setFixedLengthStreamingMode(bytes.size);connection.outputStream.use{it.write(bytes)}
            val status=connection.responseCode
            if(status !in setOf(200,201))throw HttpFailure(status)
            val response=connection.inputStream.use{input->
                val out=java.io.ByteArrayOutputStream();val buffer=ByteArray(4096)
                while(true){val n=input.read(buffer);if(n<0)break;check(out.size()+n<=16384);out.write(buffer,0,n)}
                JSONObject(out.toString("UTF-8"))
            }
            require(response.getString("idempotencyKey")==item.id)
            val listing=response.getString("listingId");require(java.util.UUID.fromString(listing).toString()==listing)
            require(response.getString("status") in setOf("created","updated","duplicate"))
            return listing
        }finally{connection.disconnect()}
    }
}
