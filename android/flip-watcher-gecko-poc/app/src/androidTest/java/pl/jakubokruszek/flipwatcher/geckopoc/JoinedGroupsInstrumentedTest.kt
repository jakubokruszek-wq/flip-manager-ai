package pl.jakubokruszek.flipwatcher.geckopoc
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
@RunWith(AndroidJUnit4::class)
class JoinedGroupsInstrumentedTest {
    private val context:Context=ApplicationProvider.getApplicationContext()
    @Test fun actualPhoneDirectoryReaderKeepsOwnMembershipsAndNamesAcrossLazyScrollWithoutImages()=runBlocking{
        val path="/groups/joins/"
        val server=LoopbackFixtureServer(pages=mapOf(path to "joined-groups")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
        try{
            val result=JoinedGroupsScan(context).runFixture("http://127.0.0.1:${server.port}$path"){true}
            assertEquals(4,result.groups.size)
            assertTrue(result.groups.any{it.url.endsWith("/234567891/")&&it.name=="Mieszkania Łódź bezpośrednio"})
            assertTrue(result.groups.any{it.url.endsWith("/345678912/")&&it.name==null})
            assertTrue(result.groups.any{it.url.endsWith("/567891234/")&&it.name=="Domy i działki Łódź"})
            assertFalse(result.groups.any{it.url.endsWith("/456789123/")||it.url.endsWith("/999999999/")})
            assertTrue(result.stats.getValue("scrollMoves")>0)
            val body=org.json.JSONObject(result.body());assertEquals(1,body.getInt("version"));assertEquals(JoinedGroupsProtocol.URL,body.getString("pageUrl"))
            assertFalse(body.has("photos"));assertFalse(body.has("postText"));assertFalse(body.has("token"))
        }finally{server.close()}
    }
}
