package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONObject
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/** Paired membership metadata only; no registry edits, Facebook cookies, post contents or images. */
object WatcherDiscoveryUpload {
    internal fun handoff(raw:String):String {
        require(raw.toByteArray().size<=4096)
        val j=JSONObject(raw);require(j.keys().asSequence().toSet()==setOf("token","expiresAt"))
        val token=j.getString("token");require(token.matches(Regex("[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\\.[a-f0-9]{64}")))
        java.time.Instant.parse(j.getString("expiresAt"))
        return WatcherLink.ORIGIN+"/facebook-watcher/groups#group-discovery="+java.net.URLEncoder.encode(token,"UTF-8")
    }
    fun send(credentials:WatcherLink.Credentials,value:JoinedGroupsResult):String {
        require(value.groups.isNotEmpty());val bytes=value.body().toByteArray();require(bytes.size<=128*1024)
        val connection=URL(WatcherLink.ORIGIN+"/api/collector/facebook/mobile/groups/discover").openConnection() as HttpsURLConnection
        try{
            connection.instanceFollowRedirects=false;connection.connectTimeout=10000;connection.readTimeout=15000
            connection.requestMethod="POST";connection.doOutput=true;connection.useCaches=false
            connection.setRequestProperty("Authorization","Bearer "+credentials.token);connection.setRequestProperty("Content-Type","application/json")
            connection.setFixedLengthStreamingMode(bytes.size);connection.outputStream.use{it.write(bytes)}
            if(connection.responseCode!=200)throw WatcherUpload.HttpFailure(connection.responseCode)
            val raw=connection.inputStream.use{input->val out=java.io.ByteArrayOutputStream();val buffer=ByteArray(1024);while(true){val n=input.read(buffer);if(n<0)break;require(out.size()+n<=4096);out.write(buffer,0,n)};String(out.toByteArray(),Charsets.UTF_8)}
            return handoff(raw)
        }finally{connection.disconnect()}
    }
}
