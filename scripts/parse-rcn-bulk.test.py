import importlib.util, pathlib, tempfile, unittest, zipfile
spec=importlib.util.spec_from_file_location('bulk',pathlib.Path(__file__).with_name('parse-rcn-bulk.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
HEADER='<gml:FeatureCollection xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:r="urn:gugik:specyfikacje:gmlas:rejestrcennieruchomosci:1.0" xmlns:xlink="http://www.w3.org/1999/xlink">'
def wrap(kind,id,body):return f'<gml:featureMember><r:{kind} gml:id="{id}">{body}</r:{kind}></gml:featureMember>'
def fixture(price=True,bundle=False):
 return HEADER+wrap('RCN_Transakcja','tx','<r:IdRCN><r:RCN_IdentyfikatorIIP><r:lokalnyId>TX-STABLE</r:lokalnyId><r:wersjaId>2026-11-01T12:00:00</r:wersjaId></r:RCN_IdentyfikatorIIP></r:IdRCN><r:rodzajTransakcji>1</r:rodzajTransakcji><r:rodzajRynku>2</r:rodzajRynku><r:cenaTransakcjiBrutto>9999999</r:cenaTransakcjiBrutto><r:podstawaPrawna xlink:href="doc"/><r:nieruchomosc xlink:href="property"/>'+('<r:nieruchomosc xlink:href="missing-property"/>' if bundle else ''))+wrap('RCN_Nieruchomosc','property','<r:rodzajNieruchomosci>4</r:rodzajNieruchomosci><r:udzialWPrawieDoNieruchomosci>1/1</r:udzialWPrawieDoNieruchomosci><r:opis>Opis nieruchomości</r:opis><r:cenaNieruchomosciBrutto>8888888</r:cenaNieruchomosciBrutto><r:lokal xlink:href="unit"/>')+wrap('RCN_Dokument','doc','<r:dataSporzadzeniaDokumentu>2026-10-01</r:dataSporzadzeniaDokumentu><r:tworcaDokumentu>PRIVATE NOTARY</r:tworcaDokumentu>')+wrap('RCN_Lokal','unit','<r:idLokalu>STABLE-UNIT</r:idLokalu><r:funkcjaLokalu>1</r:funkcjaLokalu><r:powUzytkowaLokalu>40</r:powUzytkowaLokalu>'+('<r:cenaLokaluBrutto>260000</r:cenaLokaluBrutto>' if price else '')+'<r:georeferencja><gml:Point srsName="urn:ogc:def:crs:EPSG::2177"><gml:pos>5735000 6603000</gml:pos></gml:Point></r:georeferencja><r:adresBudynkuZLokalem xlink:href="address"/>')+wrap('RCN_Adres','address','<r:miejscowosc>Łódź</r:miejscowosc><r:ulica>Tatrzańska</r:ulica><r:numerPorzadkowy>94</r:numerPorzadkowy>')+'</gml:FeatureCollection>'
class ParserTest(unittest.TestCase):
 def parse(self,xml):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'test.zip'
   with zipfile.ZipFile(p,'w') as z:z.writestr('city.gml',xml)
   return module.parse_zip(p)
 def test_linked_entities_explicit_local_price_coordinate_order_and_no_personal_fields(self):
  rows=self.parse(fixture());self.assertEqual(len(rows),1);r=rows[0]
  self.assertEqual(r['LOK_CENA_BRUTTO'],'260000');self.assertEqual(r['LOK_ID_LOKALU'],'STABLE-UNIT');self.assertEqual(r['TRAN_LOKALNY_ID_IIP'],'TX-STABLE');self.assertEqual(r['DOK_DATA'],'2026-10-01');self.assertEqual(r['TRAN_RODZAJ_RYNKU'],'rynekWtorny');self.assertEqual(r['_easting'],'6603000');self.assertEqual(r['_northing'],'5735000');self.assertIn('Opis nieruchomości',r['NIER_OPIS']);self.assertNotIn('PRIVATE NOTARY',str(r));self.assertNotIn('9999999',str(r));self.assertNotIn('8888888',str(r))
 def test_missing_local_price_never_uses_transaction_or_property_total(self):self.assertEqual(self.parse(fixture(price=False))[0]['LOK_CENA_BRUTTO'],'')
 def test_missing_asset_link_marks_entire_transaction_uncertain(self):self.assertIn('pakiet',self.parse(fixture(bundle=True))[0]['NIER_OPIS'])
 def test_dtd_and_conflicting_ids_are_rejected(self):
  with self.assertRaises(ValueError):self.parse('<!DOCTYPE bad>'+fixture())
  xml=fixture().replace('</gml:FeatureCollection>',wrap('RCN_Adres','address','<r:miejscowosc>Wrong</r:miejscowosc>')+'</gml:FeatureCollection>')
  with self.assertRaises(ValueError):self.parse(xml)
if __name__=='__main__':unittest.main()
