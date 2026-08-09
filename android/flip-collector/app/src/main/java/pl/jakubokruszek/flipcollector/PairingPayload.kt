package pl.jakubokruszek.flipcollector

import org.json.JSONObject

data class PairingPayload(val apiUrl: String, val deviceToken: String, val deviceId: String)

fun parsePairingPayload(value: String): PairingPayload? = runCatching {
    val json = JSONObject(value)
    val apiUrl = json.getString("apiUrl").trimEnd('/')
    val token = json.getString("deviceToken")
    val deviceId = json.getString("deviceId")
    require(apiUrl.startsWith("https://") && token.isNotBlank() && deviceId.isNotBlank())
    PairingPayload(apiUrl, token, deviceId)
}.getOrNull()

fun calculatedPricePerSqm(price: String, area: String): Double? {
    val parsedPrice = price.replace(',', '.').toDoubleOrNull()
    val parsedArea = area.replace(',', '.').toDoubleOrNull()
    return if (parsedPrice != null && parsedArea != null && parsedPrice > 0 && parsedArea > 0) parsedPrice / parsedArea else null
}
