package pl.jakubokruszek.flipwatcher.geckopoc

import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test

class SavedResultCodecTest {
    private fun row()=DesktopRow("550000000000099","https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/550000000000099/","DOM",319000.0,"EXPLICIT_TOTAL",42.42,2,"Polesie","Retkinia",null,"SELL_PROPERTY",true,1)
    @Test fun typedRowsRoundTripWithNullsAndSeparateOcr(){
        val value=SavedResult(1234,listOf(row()),listOf(row().copy(area=null)),emptyList())
        val encoded=org.json.JSONObject(String(SavedResultCodec.metadata(value),Charsets.UTF_8))
        assertEquals(value.rows,SavedResultCodec.rows(encoded.getJSONArray("rows")))
        assertEquals(value.ocr,SavedResultCodec.rows(encoded.getJSONArray("ocr")))
    }
    @Test fun canonicalLinkAndAllowedFieldsRemainRequired(){
        assertNull(SavedResultCodec.rows(JSONArray().put(SavedResultCodec.row(row()).put("permalink","https://example.org/"))))
        assertNull(SavedResultCodec.rows(JSONArray().put(SavedResultCodec.row(row()).put("rawHtml","secret"))))
    }
    @Test fun duplicatesAndOversizedListsAreRejected(){
        assertNull(SavedResultCodec.rows(JSONArray(List(2){SavedResultCodec.row(row())})))
        assertNull(SavedResultCodec.rows(JSONArray(List(21){SavedResultCodec.row(row())})))
    }
    @Test fun suggestionForAnotherPostCannotEnterArchive(){
        val foreign=row().copy(postId="550000000000098",permalink=row().permalink.replace("099","098"))
        assertTrue(runCatching{SavedResultCodec.metadata(SavedResult(1234,listOf(row()),listOf(foreign),emptyList()))}.isFailure)
    }
    @Test fun invalidNumbersAndUnknownIntentAreRejected(){
        assertNull(SavedResultCodec.rows(JSONArray().put(SavedResultCodec.row(row()).put("price",-1))))
        assertNull(SavedResultCodec.rows(JSONArray().put(SavedResultCodec.row(row()).put("intent","EXECUTE"))))
    }
}
