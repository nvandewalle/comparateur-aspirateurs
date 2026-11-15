import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] || resolve(root, "dist"));
const load = async name => JSON.parse(await readFile(resolve(root, name), "utf8"));
const data = await load("market-data.json");
data.analysis = await load("analysis-content.json");
data.ranges = await load("ranges-content.json");
const enrichment = await load("review-enrichment.json");
data.sources.push(...enrichment.sources);
data.sources.push(
  {id:"rr-lineup",type:"Fabricant, guide de gammes",label:"Roborock : familles actuelles et technologies",url:"https://fr.roborock.com/pages/robot-vacuums",note:"Catalogue observé en novembre 2026 ; familles Q / QV, Qrevo et Saros et variantes de lavage. Les générations coexistent."},
  {id:"eu-lineup",type:"Guide de gammes indépendant",label:"Vacuum Wars : gamme eufy 2026 expliquée",url:"https://vacuumwars.com/eufy-robot-vacuum-lineup/",note:"Distinction C / L / X / E / S. Certaines disponibilités concernent les États-Unis : ne pas les transposer à la Belgique."},
  {id:"ec-lineup",type:"Fabricant, guide de gammes",label:"Ecovacs Belgique : familles DEEBOT N, T, X et mini",url:"https://www.ecovacs.com/be-fr/deebot-robotic-vacuum-cleaner",note:"Positionnement de catalogue, pas classement de qualité de tous les modèles."}
);

function assert(ok, message) {
  if (!ok) throw new Error(message);
}
const modelIds = new Set(data.models.map(m => m.id));
const sourceIds = new Set(data.sources.map(s => s.id));
const sourceMap = new Map(data.sources.map(s => [s.id,s]));
assert(modelIds.size === data.models.length, "Duplicate model id");
assert(sourceIds.size === data.sources.length, "Duplicate source id");
const enrichmentMap = new Map(enrichment.models.map(m => [m.id,m]));
assert(enrichmentMap.size === enrichment.models.length, "Duplicate enrichment model id");
assert(enrichmentMap.size === modelIds.size && [...enrichmentMap.keys()].every(id => modelIds.has(id)), "Enrichment must cover every model exactly once");
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}
assert(validDate(enrichment.checkedAt), "Invalid review research date");
const updateKeys = new Set(["robot","dimNote","cons","detergent","detergentNote","washMode","washNote"]);
for (const m of data.models) {
  const e = enrichmentMap.get(m.id);
  assert(e.release && e.cameraInfo && e.remoteCamera && e.frandroid, `Incomplete enrichment ${m.id}`);
  assert(["tested","not-found"].includes(e.frandroid.status), `Invalid Frandroid status ${m.id}`);
  const tested = e.frandroid.status === "tested";
  const reviewSources = tested ? [e.frandroid.source] : [enrichment.catalogue.index,enrichment.catalogue.brands[m.brand]];
  assert(reviewSources.every(id => sourceMap.has(id)), `Missing Frandroid evidence ${m.id}`);
  m.release = e.release;
  m.cameraInfo = e.cameraInfo;
  m.camera = e.cameraInfo.value;
  m.remoteCamera = e.remoteCamera;
  m.frandroid = {
    score:null,published:null,updated:null,source:null,url:null,
    summary:`Test exact non repéré au ${enrichment.checkedAt.split("-").reverse().join("/")}.`,
    ...e.frandroid,
    max:10,checkedAt:enrichment.checkedAt,sources:reviewSources
  };
  if (tested) {
    m.frandroid.url = sourceMap.get(e.frandroid.source).url;
    m.tested = true;
  }
  for (const [key,value] of Object.entries(e.updates || {})) {
    assert(updateKeys.has(key), `Unexpected enrichment update ${m.id}.${key}`);
    m[key] = value;
  }
  m.sources = [...new Set([...m.sources,...m.release.sources,...m.cameraInfo.sources,...m.remoteCamera.sources,...reviewSources])];
}
data.reviewResearch = {
  checkedAt:enrichment.checkedAt,method:enrichment.method,catalogue:enrichment.catalogue,
  tested:data.models.filter(m => m.frandroid.status === "tested").length,
  notFound:data.models.filter(m => m.frandroid.status === "not-found").length
};
function checkSources(ids, where) {
  assert(Array.isArray(ids) && ids.length > 0, `Empty evidence in ${where}`);
  for (const id of ids) assert(sourceIds.has(id), `Missing source ${id} in ${where}`);
}
for (const s of data.sources) {
  const u = new URL(s.url);
  assert(u.protocol === "https:", `Unexpected source URL: ${s.id}`);
}
for (const m of data.models) {
  assert(m.name && m.brand && data.haProfiles[m.ha], `Incomplete model ${m.id}`);
  assert(["rotatifs","rouleau"].includes(m.mop), `Invalid mop ${m.id}`);
  assert(m.robot.length === 3 && m.dock.length === 3, `Invalid dimensions ${m.id}`);
  assert([...m.robot,...m.dock].every(v => v === null || Number.isFinite(v) && v > 0), `Invalid dimension value ${m.id}`);
  assert(m.release.month === null || /^\d{4}-(0[1-9]|1[0-2])$/.test(m.release.month), `Invalid release month ${m.id}`);
  assert(m.release.market && m.release.basis && m.release.note, `Unqualified release date ${m.id}`);
  assert([true,false,null].includes(m.camera) && m.cameraInfo.kind && m.cameraInfo.note, `Invalid camera evidence ${m.id}`);
  assert([true,false,null].includes(m.remoteCamera.available) && m.remoteCamera.note, `Invalid remote camera evidence ${m.id}`);
  assert(m.remoteCamera.available !== true || m.camera === true, `Remote video without a confirmed camera ${m.id}`);
  checkSources(m.release.sources, `${m.id} release`);
  checkSources(m.cameraInfo.sources, `${m.id} camera`);
  checkSources(m.remoteCamera.sources, `${m.id} remote video`);
  checkSources(m.frandroid.sources, `${m.id} Frandroid`);
  if (m.frandroid.status === "tested") {
    assert(Number.isFinite(m.frandroid.score) && m.frandroid.score > 0 && m.frandroid.score <= 10 && m.frandroid.max === 10, `Invalid Frandroid score ${m.id}`);
    assert(validDate(m.frandroid.published) && validDate(m.frandroid.updated), `Invalid Frandroid dates ${m.id}`);
    assert(m.frandroid.published <= m.frandroid.updated && m.frandroid.updated <= enrichment.checkedAt, `Invalid Frandroid chronology ${m.id}`);
    assert(m.frandroid.summary && m.frandroid.scope, `Incomplete Frandroid summary ${m.id}`);
    assert(new URL(m.frandroid.url).hostname === "www.frandroid.com", `Unexpected review publisher ${m.id}`);
  } else {
    assert(m.frandroid.score === null && m.frandroid.published === null && m.frandroid.updated === null && m.frandroid.url === null && m.frandroid.source === null, `Unverified Frandroid rating ${m.id}`);
    assert(m.frandroid.note, `Missing exact-model search note ${m.id}`);
  }
  if (m.washMode === "ambient") assert(m.wash === null, `Ambient wash must not be encoded as degrees ${m.id}`);
  checkSources(m.sources, m.id);
  checkSources(data.haProfiles[m.ha].sources, m.ha);
  if (m.review.source) checkSources([m.review.source], `${m.id} reviews`);
  for (const metric of m.metrics || []) checkSources([metric.source], `${m.id} metrics`);
  for (const o of m.offers) {
    checkSources([o.source], `${m.id} offer`);
    assert(o.price === null || Number.isFinite(o.price) && o.price > 0, `Invalid price ${m.id}`);
    assert(o.shipping === null || Number.isFinite(o.shipping) && o.shipping >= 0, `Invalid shipping ${m.id}`);
    assert([true,false,null].includes(o.be), `Invalid delivery flag ${m.id}`);
    assert([true,false,null].includes(o.available), `Invalid availability ${m.id}`);
    if (o.url) assert(new URL(o.url).protocol === "https:", `Invalid offer URL ${m.id}`);
  }
}
for (const section of data.analysis.sections) checkSources(section.sources, section.id);
for (const guide of data.ranges.brands) {
  checkSources(guide.sources, guide.brand);
  for (const family of guide.families) for (const id of family.models) assert(modelIds.has(id), `Unknown range model ${id}`);
  for (const pair of guide.pairs) assert(modelIds.has(pair.a) && modelIds.has(pair.b), `Unknown pair ${guide.brand}`);
}
for (const r of data.recommendations) assert(modelIds.has(r.id), `Unknown recommendation ${r.id}`);
const photos = await load("product-images.json");
assert(validDate(photos.checkedAt) && Array.isArray(photos.images), "Invalid photo catalogue");
assert(new Set(photos.images.map(photo => photo.id)).size === photos.images.length, "Duplicate product photo");
for (const photo of photos.images) {
  const model = data.models.find(m => m.id === photo.id);
  assert(model, `Photo for unknown model ${photo.id}`);
  assert(photo.alt && photo.credit && photo.sourceTitle, `Unidentified product photo ${photo.id}`);
  for (const key of ["sourceUrl","imageUrl"]) {
    assert(new URL(photo[key]).protocol === "https:", `Invalid photo ${key} ${photo.id}`);
  }
  assert(Number.isInteger(photo.width) && photo.width > 0, `Invalid photo width ${photo.id}`);
  assert(Number.isInteger(photo.height) && photo.height > 0, `Invalid photo height ${photo.id}`);
  model.photo = {...photo,src:photo.imageUrl};
}
data.photoResearch = {
  checkedAt:photos.checkedAt,
  available:photos.images.length,
  missing:data.models.filter(m => !m.photo).map(m => m.id)
};
if (data.photoResearch.missing.length) console.warn(`Product photos unavailable: ${data.photoResearch.missing.join(", ")}`);
let html = await readFile(resolve(root, "comparator.template.html"), "utf8");
assert(html.split("__MARKET_DATA__").length === 2, "Expected exactly one data placeholder");
html = html.replace("__MARKET_DATA__", JSON.stringify(data).replaceAll("<", "\\u003c"));
assert(html.split("__IMAGE_HOSTS__").length === 2, "Expected exactly one image-host placeholder");
html = html.replace("__IMAGE_HOSTS__", [...new Set(photos.images.map(photo => new URL(photo.imageUrl).origin))].sort().join(" "));
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (/application\/json/i.test(match[1])) continue;
  new Script(match[2], { filename: "comparateur-aspirateurs.html" });
}
assert(!/<script[^>]+src\s*=|<link[^>]+href\s*=/i.test(html), "Unexpected external runtime dependency");
await mkdir(out, { recursive: true });
const filename = resolve(out, "comparateur-aspirateurs.html");
await writeFile(filename, html, "utf8");
console.log(JSON.stringify({
  file:filename,
  bytes:Buffer.byteLength(html),
  models:data.models.length,
  sources:data.sources.length,
  offers:data.models.reduce((n,m)=>n+m.offers.length,0),
  rangeGuides:data.ranges.brands.length,
  frandroidTests:data.reviewResearch.tested,
  frandroidNotFound:data.reviewResearch.notFound,
  releaseMonths:data.models.filter(m=>m.release.month).length,
  remoteVideoConfirmed:data.models.filter(m=>m.remoteCamera.available===true).length,
  photos:data.photoResearch.available,
  missingPhotos:data.photoResearch.missing
}, null, 2));
