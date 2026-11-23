import { parameterStatus } from './measurementStatus';
import type { MonitoringParameter } from './monitoringRecommendations';
import { lldaAdvisoryUrl, type Recommendation } from './recommendations';

type Copy = [english: string, filipino: string];
type ActionCopy = { condition: Copy; check: Copy; action: Copy; escalate: Copy };

const llda = { label: 'LLDA: Laguna de Bay algal bloom advisory', href: lldaAdvisoryUrl };
const fao = { label: 'FAO: Water quality for aquaculture', href: 'https://www.fao.org/fileadmin/templates/SEC/docs/Fishery/Fisheries_Events_2012/Water_Quality_for_Aquaculture_and_Impact_of_Aquaculture_to_Environments.pdf' };
const references = {
  dissolvedOxygen: [llda, { label: 'LSU AgCenter: Oxygen depletion and fish kills (pond guidance)', href: 'https://www.lsuagcenter.com/topics/aquaculture/recreational_ponds/oxygen_depletions_and_other_types_of_fish_kills/oxygen-depletion-and-other-fish-kills' }],
  ph: [{ label: 'Yokogawa: pH in Fish Farming (technical note)', href: 'https://www.yokogawa.com/ph/library/resources/application-notes/ph-in-fish-farming/' }, fao],
  temperature: [fao],
  turbidity: [{ label: 'USGS: Turbidity and Water', href: 'https://www.usgs.gov/water-science-school/science/turbidity-and-water' }, llda]
};

export function sensorActionGuidance(item: Recommendation & { parameter: MonitoringParameter }, lang: 'en' | 'tl') {
  if (!item.source || item.value === null || !Number.isFinite(item.value) ||
    (item.state !== 'warning' && item.state !== 'critical')) return null;
  const critical = item.state === 'critical';
  const dashboardStatus = parameterStatus(item.parameter, item.value);
  const low = item.value < item.range[0];
  let copy: ActionCopy;
  switch (item.parameter) {
    case 'dissolvedOxygen':
      copy = low ? {
        condition: ['Low oxygen can make it harder for fish to breathe. This reading does not tell you how the fish are behaving.', 'Maaaring mahirapang huminga ang isda kapag mababa ang oxygen. Hindi ipinapakita ng sukat na ito ang kilos ng isda.'],
        check: ['Check for fish gathering near the surface, gasping, swimming unusually, or eating less. Check especially near dawn. Confirm DO with another calibrated meter if available.', 'Tingnan kung nagtitipon sa ibabaw, sumisinghap, kakaiba ang paglangoy, o kumakain nang kaunti ang isda. Magbantay lalo na sa madaling araw. Kumpirmahin ang DO gamit ang ibang calibrated na metro kung mayroon.'],
        action: critical
          ? ['If the critical reading is reliable, manually start a suitable mechanical aerator or paddle wheel promptly, if available and safe. Do not wait for fish to gasp or for a repeat test. Recheck DO after aerating and avoid excess feed.', 'Kung maaasahan ang kritikal na sukat, paandarin agad nang mano-mano ang angkop na aerator o paddle wheel kung mayroon at ligtas. Huwag hintaying suminghap ang isda o matapos ang muling pagsusukat. Sukatin ulit ang DO at huwag magpakain nang sobra.']
          : ['Check DO and fish more often. Prepare an aerator or paddle wheel if available. If you observe oxygen-related distress, manually start suitable aeration if safe, then recheck DO. Avoid excess feed.', 'Mas madalas na sukatin ang DO at obserbahan ang isda. Ihanda ang aerator o paddle wheel kung mayroon. Kung may hirap sa paghinga dahil sa mababang oxygen, paandarin ito nang mano-mano kung ligtas, tapos sukatin ulit ang DO. Huwag magpakain nang sobra.'],
        escalate: ['Contact local fisheries staff promptly if DO stays critically low or fish still gasp after aeration. Consider early harvest only as a last resort if severe distress persists, fish are already marketable, and fisheries staff advise it. Report unusual blooms, discoloration, foul odors, or mass fish deaths to LLDA.', 'Makipag-ugnayan agad sa lokal na fisheries officer kung nananatiling kritikal ang DO o sumisinghap pa rin ang isda matapos mag-aerate. Pag-isipan lang ang maagang pag-ani bilang huling opsyon kung tuloy ang matinding distress, maaari nang ibenta ang isda, at payo ito ng fisheries officer. Iulat sa LLDA ang kakaibang pamumulaklak ng algae, kulay, amoy, o maramihang pagkamatay ng isda.']
      } : {
        condition: ['DO is above the application range. This is not an oxygen shortage.', 'Mas mataas sa saklaw ng app ang DO. Hindi ito kakulangan ng oxygen.'],
        check: ['Verify with a calibrated DO meter and observe swimming and feeding.', 'Kumpirmahin gamit ang calibrated na DO meter at obserbahan ang paglangoy at pagkain ng isda.'],
        action: ['Record the time and track DO trends. Do not start aeration based on this high reading alone.', 'Itala ang oras at bantayan ang pagbabago ng DO. Huwag magpaandar ng aerator dahil lang sa mataas na sukat na ito.'],
        escalate: ['Contact local fisheries staff if readings stay unusual or fish show distress.', 'Kumonsulta sa lokal na fisheries officer kung patuloy na kakaiba ang sukat o hirap ang isda.']
      };
      break;
    case 'ph':
      copy = {
        condition: low ? ['Low pH means the water is more acidic and may stress fish.', 'Mas acidic ang tubig kapag mababa ang pH at maaari itong maka-stress sa isda.'] :
          ['High pH means the water is more alkaline and may stress fish.', 'Mas alkaline ang tubig kapag mataas ang pH at maaari itong maka-stress sa isda.'],
        check: ['Confirm with a calibrated pH meter or test kit. Observe swimming and feeding. Note the time: pH can differ between morning and afternoon.', 'Kumpirmahin gamit ang calibrated na pH meter o test kit. Obserbahan ang paglangoy at pagkain. Itala ang oras: maaaring magkaiba ang pH sa umaga at hapon.'],
        action: critical
          ? ['Recheck promptly and ask fisheries staff for guidance. If fish are stressed or not feeding, reduce or temporarily pause feeding. Do not add lime, acid, fertilizer, or other chemicals to the open fishpen.', 'Sukatin agad ulit at humingi ng payo sa fisheries officer. Kung hirap o ayaw kumain ang isda, bawasan o itigil muna ang pagpapakain. Huwag maglagay ng apog, asido, abono, o ibang kemikal sa palaisdaan sa lawa.']
          : ['Record pH at comparable times and monitor the trend and fish behavior. Do not add lime, acid, fertilizer, or other chemicals to the open fishpen.', 'Magtala ng pH sa magkatulad na oras at bantayan ang pagbabago at kilos ng isda. Huwag maglagay ng apog, asido, abono, o ibang kemikal sa palaisdaan sa lawa.'],
        escalate: ['Contact BFAR or local fisheries staff if pH remains abnormal. Seek urgent help if the reading is extreme or fish show severe distress.', 'Kumonsulta sa BFAR o lokal na fisheries officer kung patuloy na labas sa saklaw ang pH. Humingi agad ng tulong kung sobrang baba o taas ng pH o matindi ang distress ng isda.']
      };
      break;
    case 'temperature':
      copy = {
        condition: low ? ['Unusually cool water can reduce fish activity and appetite.', 'Kapag malamig ang tubig, maaaring humina ang galaw at gana ng isda.'] :
          ['Warmer water holds less oxygen, while fish may need more.', 'Mas kaunting oxygen ang kayang taglayin ng mas mainit na tubig, habang maaaring mas kailangan ito ng isda.'],
        check: ['Confirm with another thermometer if available. Check for a sudden change, observe fish activity and feeding, and measure DO if you can.', 'Kumpirmahin gamit ang ibang thermometer kung mayroon. Tingnan kung biglang nagbago ang temperatura, obserbahan ang galaw at pagkain, at sukatin ang DO kung kaya.'],
        action: low
          ? ['Track temperature and DO. If fish eat less, adjust feeding to avoid leftovers. Do not try to heat the open lake.', 'Bantayan ang temperatura at DO. Kung mahina ang kain, iangkop ang pakain para walang tira. Huwag subukang painitin ang lawa.']
          : ['Track temperature and DO. Reduce feed if heat-stressed fish are eating less and avoid unnecessary handling. Do not try to cool the open lake.', 'Bantayan ang temperatura at DO. Bawasan ang pakain kung mahina ang kain dahil sa init at iwasan ang hindi kailangang paghawak. Huwag subukang palamigin ang lawa.'],
        escalate: ['Contact local fisheries staff if extreme temperature persists, DO falls, or fish show serious distress.', 'Kumonsulta sa lokal na fisheries officer kung tumatagal ang sobrang init o lamig, bumababa ang DO, o matindi ang distress ng isda.']
      };
      break;
    case 'turbidity':
      copy = {
        condition: low
          ? ['The reading is below the app reference range. Clearer water alone is not evidence of fish distress.', 'Mas mababa sa saklaw ng app ang sukat. Hindi sapat ang mas malinaw na tubig para masabing hirap ang isda.']
          : ['Cloudiness may come from sediment, runoff, or algae. Turbidity alone cannot identify an algal bloom.', 'Maaaring galing sa putik, agos mula sa ulan, o algae ang labo. Hindi makukumpirma ang algal bloom gamit lang ang sukat ng labo.'],
        check: ['Check calibration and repeat the reading. Note muddy or green water, recent rain, and fish behavior. Measure DO if possible, especially near dawn or after cloudy weather.', 'Suriin ang calibration at sukatin ulit. Itala kung maputik o berde ang tubig, kung umulan, at ang kilos ng isda. Sukatin ang DO kung maaari, lalo na sa madaling araw o pagkatapos ng maulap na panahon.'],
        action: (critical || dashboardStatus === 'critical') && !low
          ? ['Check water flow around the nets and monitor DO for oxygen stress. If fish are stressed or eating less, reduce or pause feeding. Do not add alum, gypsum, fertilizer, or other pond-treatment chemicals.', 'Suriin ang daloy sa paligid ng lambat at bantayan ang DO. Kung hirap o mahina ang kain ng isda, bawasan o itigil muna ang pakain. Huwag maglagay ng tawas, gypsum, abono, o ibang kemikal na pang-pond.']
          : ['Monitor readings, DO, and fish behavior more often. Do not add alum, gypsum, fertilizer, or other pond-treatment chemicals.', 'Mas madalas na bantayan ang mga sukat, DO, at kilos ng isda. Huwag maglagay ng tawas, gypsum, abono, o ibang kemikal na pang-pond.'],
        escalate: ['Contact local fisheries staff if water stays unusually cloudy, DO falls, or fish show distress. Report unusual discoloration, foul odors, suspected blooms, or mass fish deaths to LLDA.', 'Kumonsulta sa lokal na fisheries officer kung tuloy ang matinding labo, bumababa ang DO, o hirap ang isda. Iulat sa LLDA ang kakaibang kulay, mabahong amoy, hinihinalang algal bloom, o maramihang pagkamatay ng isda.']
      };
  }
  const t = lang === 'tl' ? 1 : 0;
  return {
    condition: copy.condition[t], check: copy.check[t], action: copy.action[t], escalate: copy.escalate[t],
    references: references[item.parameter], dashboardStatus
  };
}
