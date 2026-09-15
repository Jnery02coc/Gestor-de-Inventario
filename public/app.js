const DEFAULT_PRODUCTS = [];
function uid(){return (crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2))}
function get(k,f){try{let v=JSON.parse(localStorage.getItem(k));return v??f}catch{return f}}
const DEPLOY_CONFIG=window.MI_BODEGA_DEPLOY||{};
const cloudConfig=get("b34_cloud_config",{
 url:String(DEPLOY_CONFIG.apiUrl||""),
 token:String(DEPLOY_CONFIG.token||""),
 proxy:!!DEPLOY_CONFIG.proxy,
 enabled:!!DEPLOY_CONFIG.enabled,
 autoSync:true,
 lastSync:"",
 status:"local"
});
if(DEPLOY_CONFIG.enabled&&DEPLOY_CONFIG.apiUrl){
 cloudConfig.url=String(DEPLOY_CONFIG.apiUrl);
 cloudConfig.proxy=!!DEPLOY_CONFIG.proxy;
 cloudConfig.enabled=true;
 if(DEPLOY_CONFIG.token)cloudConfig.token=String(DEPLOY_CONFIG.token);
}
// V80: en modo Proxy el Token pertenece únicamente a Netlify. Eliminar cualquier
// copia heredada de versiones antiguas que pudiera quedar en localStorage.
if(cloudConfig.proxy&&cloudConfig.token){
 cloudConfig.token="";
 localStorage.setItem("b34_cloud_config",JSON.stringify(cloudConfig));
}
let cloudSyncTimer=null,cloudSyncing=false,cloudLoading=false;
const AUTO_CENTRAL_CHECK_MS=6000;
const CENTRAL_REVISION_KEY="b34_central_revision";
const LOCAL_DIRTY_KEY="b34_unsynced_changes";
let centralRevision=localStorage.getItem(CENTRAL_REVISION_KEY)||"";
let centralAutoTimer=null,centralAutoChecking=false;
let localChangeSerial=0,lastPushedSerial=0;
let persistentLocalDirty=localStorage.getItem(LOCAL_DIRTY_KEY)==="1";
function hasUnsyncedLocalChanges(){return persistentLocalDirty||localChangeSerial>lastPushedSerial;}
function markUnsyncedLocalChanges(){persistentLocalDirty=true;localStorage.setItem(LOCAL_DIRTY_KEY,"1");}
function markLocalChangesSynced(){persistentLocalDirty=false;localStorage.removeItem(LOCAL_DIRTY_KEY);}
let centralLastOk=0,centralLastError="";
const authState={
 required:false,
 configured:true,
 securityConfigured:false,
 authenticated:true,
 checking:false,
 localOnly:false,
 lastError:""
};
function setSecurityMessage(){ }
function openSecurityLogin(){ }
function closeSecurityLogin(){ }
function handleCloudUnauthorized(data={}){
 authState.authenticated=true;
 authState.lastError=String(data?.error||"");
}
async function checkServerAuth(silent=true){
 if(!cloudConfig.enabled||!cloudReady())return false;
 try{
   const u=new URL(normalizeCloudUrl(cloudConfig.url),location.href);
   u.searchParams.set("action","netlify_health");u.searchParams.set("_",Date.now());
   const res=await fetch(u.toString(),{method:"GET",cache:"no-store",credentials:"same-origin"});
   const data=await res.json();
   authState.configured=!!data.configured;
   authState.authenticated=!!data.configured;
   if(!data.configured){if(!silent)toast("Falta configurar la conexión de Google Sheets en Netlify.");return false;}
   return true;
 }catch(err){
   authState.lastError=String(err?.message||err);
   if(!silent)toast("No se pudo comprobar la conexión de Netlify.");
   return false;
 }
}
async function loginServerPin(){authState.authenticated=true;return true;}
async function logoutServerSession(){authState.authenticated=true;return true;}
async function resumeCentralSyncAfterAuth(){
 if(!cloudConfig.enabled||!cloudReady())return false;
 // V80.3: si este navegador tiene cambios que todavía no llegaron a Google Sheets,
 // SIEMPRE se suben primero. Nunca descargar encima de trabajo local pendiente.
 if(hasUnsyncedLocalChanges()){
   const pushed=await syncToCloud(true);
   if(!pushed){
     toast("Tus cambios siguen guardados en este dispositivo. Se reintentará la sincronización.");
     queueCloudSync(4000);
     startLivePolling();
     return false;
   }
 }
 await syncFromCloud(true);
 await recoverDifferenceHistoryFromSheets(true);
 await recoverWeeklyHistoryList(true);
 await recoverDigitalHistoryList(true);
 await initializeLiveSync();
 if(pendingDifferenceSyncCount())scheduleDifferenceHistorySync(700);
 if(pendingWeeklyArchiveCount())setTimeout(()=>syncWeeklyArchiveQueue(false),850);
 if(pendingDigitalArchiveCount())setTimeout(()=>syncDigitalArchiveQueue(false),1000);
 if(state.baseProductSyncQueue?.length)scheduleBaseProductQueueSync(1300);
 return true;
}
const state={
 page:"inicio",
 inventory:get("b34_inventory",DEFAULT_PRODUCTS),
 movements:get("b34_movements",[]),
 counts:get("b34_counts",[]),
 weeklyCounts:get("b34_weekly_counts",{}),
 settings:get("b34_settings",{name:"Mi Bodega",dark:false,technicians:[],keepers:[],logoDataUrl:""}),
 weeklyMeta:get("b34_weekly_meta",{active:false,label:"",responsible:"",closed:false,filterFamily:"",dateFrom:"",dateTo:"",productIds:[],extraProducts:[]}),
 weeklyHistoryMeta:get("b34_weekly_history_meta",[]),
 weeklyArchiveQueue:get("b34_weekly_archive_queue",[]),
 digitalHistory:get("b34_digital_history",[]),
 digitalArchiveQueue:get("b34_digital_archive_queue",[]),
 digitalCounts:get("b34_digital_counts",{}),
 digitalFilter:get("b34_digital_filter",{family:"",search:"",field:"name",condition:"none",value1:"",value2:"",responsible:""}),
 digitalClosedFamilies:get("b34_digital_closed_families",{}),
 digitalAdjustments:get("b34_digital_adjustments",[]),
 differenceHistory:get("b34_difference_history",[]),
 pendingBaseProducts:get("b34_pending_base_products",[]),
 baseProductSyncQueue:get("b34_base_product_sync_queue",[]),
 stockoutRecords:get("b34_stockout_records",[]),
 movementTombstones:get("b34_movement_tombstones",{}),
 inventoryVersionAt:get("b34_inventory_version_at",""),
 digitalResetAt:get("b34_digital_reset_at",""),
 factoryResetAt:get("b34_factory_reset_at","")
};
if(typeof state.weeklyMeta.active!=="boolean")state.weeklyMeta.active=!!(state.weeklyMeta.label&&Object.keys(state.weeklyCounts||{}).length);
if(!Array.isArray(state.weeklyMeta.productIds)){
  state.weeklyMeta.productIds=Object.keys(state.weeklyCounts||{});
}
if(typeof state.weeklyMeta.responsible!=="string")state.weeklyMeta.responsible="";
if(!Array.isArray(state.weeklyMeta.extraProducts))state.weeklyMeta.extraProducts=[];
if(!Array.isArray(state.weeklyHistoryMeta))state.weeklyHistoryMeta=[];
if(!Array.isArray(state.weeklyArchiveQueue))state.weeklyArchiveQueue=[];
if(!Array.isArray(state.digitalHistory))state.digitalHistory=[];
if(!Array.isArray(state.digitalArchiveQueue))state.digitalArchiveQueue=[];
if(typeof state.settings.logoDataUrl!=="string")state.settings.logoDataUrl="";
if(typeof state.digitalFilter.responsible!=="string")state.digitalFilter.responsible="";
if(!Array.isArray(state.differenceHistory))state.differenceHistory=[];
state.differenceHistory.forEach(r=>{
 if(r&&typeof r.needsSync!=="boolean")r.needsSync=true;
});
if(!Array.isArray(state.stockoutRecords))state.stockoutRecords=[];
if(!state.movementTombstones||typeof state.movementTombstones!=="object")state.movementTombstones={};
if(typeof state.inventoryVersionAt!=="string")state.inventoryVersionAt="";
if(typeof state.digitalResetAt!=="string")state.digitalResetAt="";
if(typeof state.factoryResetAt!=="string")state.factoryResetAt="";
migrateLegacyDigitalHistoryStorage();
normalizeCatalogFields();
ensureMasterImportOrder();
syncStockoutRecordsFromInventory("Migración");
localStorage.setItem("b34_stockout_records",JSON.stringify(state.stockoutRecords));
let editingProductId=null,currentProductId=null,currentMovementId=null,editingMovementId=null;
let digitalCalcTargetId="",digitalCalcDisplay="0",digitalCalcStored=null,digitalCalcOp=null,digitalCalcWaiting=false;
let differenceView="open";
let digitalView="current";
let digitalFamiliesPageView="families";
let digitalHistorySelectedId="";
let digitalHistoryLoadedArchive=null,digitalHistoryLoadingId="";
const digitalHistoryCache=new Map();
let weeklyView="current";
let weeklyHistorySelectedId="";
let weeklyHistoryLoadedArchive=null;
let weeklyHistoryLoading=false;
const titles={inicio:"Inicio",inventario:"Inventario",salida:"Control de Salida",conteo:"Conteo Semanal",diferencias:"Diferencias",sinexist:"Sin Existencia",digital:"Inventario Digital",familias:"Familias Contadas",herramientas:"Herramientas",nuevos:"Códigos Nuevos",config:"Configuración"};
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
function esc(v=""){return String(v).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}
function catalogText(v){
 return v===null||v===undefined?"":String(v);
}
function normalizeCatalogFields(){
 if(Array.isArray(state.inventory))state.inventory.forEach(p=>{if(p)p.catalog=catalogText(p.catalog);});
 if(Array.isArray(state.pendingBaseProducts))state.pendingBaseProducts.forEach(p=>{if(p)p.catalog=catalogText(p.catalog);});
 if(Array.isArray(state.differenceHistory))state.differenceHistory.forEach(r=>{if(r)r.catalog=catalogText(r.catalog);});
 if(Array.isArray(state.digitalHistory))state.digitalHistory.forEach(a=>{if(a&&Array.isArray(a.items))a.items.forEach(r=>{if(r)r.catalog=catalogText(r.catalog);});});
 if(Array.isArray(state.digitalArchiveQueue))state.digitalArchiveQueue.forEach(a=>{if(a&&Array.isArray(a.items))a.items.forEach(r=>{if(r)r.catalog=catalogText(r.catalog);});});
 if(Array.isArray(state.stockoutRecords))state.stockoutRecords.forEach(r=>{if(r)r.catalog=catalogText(r.catalog);});
 if(state.weeklyMeta&&Array.isArray(state.weeklyMeta.extraProducts))state.weeklyMeta.extraProducts.forEach(p=>{if(p)p.catalog=catalogText(p.catalog);});
}
function saveCloudConfig(){
 localStorage.setItem("b34_cloud_config",JSON.stringify(cloudConfig));
}
function saveLocal(){
 localStorage.setItem("b34_inventory",JSON.stringify(state.inventory));
 localStorage.setItem("b34_movements",JSON.stringify(state.movements));
 localStorage.setItem("b34_counts",JSON.stringify(state.counts));
 localStorage.setItem("b34_weekly_counts",JSON.stringify(state.weeklyCounts));
 localStorage.setItem("b34_settings",JSON.stringify(state.settings));
 localStorage.setItem("b34_weekly_meta",JSON.stringify(state.weeklyMeta));
 localStorage.setItem("b34_weekly_history_meta",JSON.stringify(state.weeklyHistoryMeta));
 localStorage.setItem("b34_weekly_archive_queue",JSON.stringify(state.weeklyArchiveQueue));
 localStorage.setItem("b34_digital_counts",JSON.stringify(state.digitalCounts));
 localStorage.setItem("b34_digital_filter",JSON.stringify(state.digitalFilter));
 localStorage.setItem("b34_digital_closed_families",JSON.stringify(state.digitalClosedFamilies));
 localStorage.setItem("b34_digital_history",JSON.stringify(state.digitalHistory));
 localStorage.setItem("b34_digital_archive_queue",JSON.stringify(state.digitalArchiveQueue));
 localStorage.setItem("b34_digital_adjustments",JSON.stringify(state.digitalAdjustments));
 localStorage.setItem("b34_difference_history",JSON.stringify(state.differenceHistory));
 localStorage.setItem("b34_pending_base_products",JSON.stringify(state.pendingBaseProducts));
 localStorage.setItem("b34_base_product_sync_queue",JSON.stringify(state.baseProductSyncQueue));
 localStorage.setItem("b34_stockout_records",JSON.stringify(state.stockoutRecords));
 localStorage.setItem("b34_movement_tombstones",JSON.stringify(state.movementTombstones));
 localStorage.setItem("b34_inventory_version_at",JSON.stringify(state.inventoryVersionAt||""));
 localStorage.setItem("b34_digital_reset_at",JSON.stringify(state.digitalResetAt||""));
 localStorage.setItem("b34_factory_reset_at",JSON.stringify(state.factoryResetAt||""));
}
function save(){
 saveLocal();
 if(!cloudLoading){
   localChangeSerial++;
   markUnsyncedLocalChanges();
   if(cloudConfig.enabled&&cloudConfig.autoSync&&cloudReady()) queueCloudSync(900);
 }
}
function cloudSnapshot(){
 return {
   version:"V80.3.5 COMPLETA",
   savedAt:new Date().toISOString(),
   inventory:state.inventory,
   movements:state.movements,
   counts:state.counts,
   weeklyCounts:state.weeklyCounts,
   settings:state.settings,
   weeklyMeta:state.weeklyMeta,
   weeklyHistoryMeta:state.weeklyHistoryMeta,
   digitalCounts:state.digitalCounts,
   digitalFilter:state.digitalFilter,
   digitalClosedFamilies:state.digitalClosedFamilies,
   digitalHistory:state.digitalHistory,
   digitalAdjustments:state.digitalAdjustments,
   differenceHistory:state.differenceHistory,
   pendingBaseProducts:state.pendingBaseProducts,
   stockoutRecords:state.stockoutRecords,
   movementTombstones:state.movementTombstones,
   inventoryVersionAt:state.inventoryVersionAt||"",
   digitalResetAt:state.digitalResetAt||"",
   factoryResetAt:state.factoryResetAt||""
 };
}
function resetLocalToFactory(factoryResetAt=""){
 const at=String(factoryResetAt||new Date().toISOString());
 clearTimeout(cloudSyncTimer);cloudSyncTimer=null;
 try{clearTimeout(differenceHistorySyncTimer);differenceHistorySyncTimer=null;}catch{}
 try{clearTimeout(baseProductQueueTimer);baseProductQueueTimer=null;}catch{}
 localChangeSerial=0;lastPushedSerial=0;
 markLocalChangesSynced();

 state.page="inicio";
 state.inventory=[];
 state.movements=[];
 state.counts=[];
 state.weeklyCounts={};
 state.settings={name:"Mi Bodega",dark:false,technicians:[],keepers:[],logoDataUrl:""};
 state.weeklyMeta={active:false,label:"",responsible:"",closed:false,filterFamily:"",dateFrom:"",dateTo:"",productIds:[],extraProducts:[]};
 state.weeklyHistoryMeta=[];
 state.weeklyArchiveQueue=[];
 state.digitalHistory=[];
 state.digitalArchiveQueue=[];
 state.digitalCounts={};
 state.digitalFilter={family:"",search:"",field:"name",condition:"none",value1:"",value2:"",responsible:""};
 state.digitalClosedFamilies={};
 state.digitalAdjustments=[];
 state.differenceHistory=[];
 state.pendingBaseProducts=[];
 state.baseProductSyncQueue=[];
 state.stockoutRecords=[];
 state.movementTombstones={};
 state.inventoryVersionAt="";
 state.digitalResetAt=at;
 state.factoryResetAt=at;

 try{digitalHistoryCache.clear();}catch{}
 try{digitalHistorySelectedId="";digitalHistoryLoadedArchive=null;digitalHistoryLoadingId="";}catch{}
 try{weeklyHistorySelectedId="";weeklyHistoryLoadedArchive=null;weeklyHistoryLoading=false;}catch{}
 try{differenceView="open";digitalView="current";digitalFamiliesPageView="families";weeklyView="current";}catch{}
 try{liveState.cursor=0;localStorage.setItem(LIVE_CURSOR_KEY,"0");}catch{}
 localStorage.setItem(CENTRAL_REVISION_KEY,"");
 centralRevision="";
 document.body.classList.remove("dark");
 saveLocal();
 applyBranding();
 return at;
}

function applyCloudSnapshot(data){
 if(!data||typeof data!=="object")return false;
 cloudLoading=true;
 try{
   const remoteFactoryResetAt=String(data.factoryResetAt||"");
   const localFactoryResetAt=String(state.factoryResetAt||"");
   const remoteResetMs=Date.parse(remoteFactoryResetAt)||0;
   const localResetMs=Date.parse(localFactoryResetAt)||0;
   const forceFactoryReset=!!remoteResetMs && remoteResetMs>localResetMs;
   if(forceFactoryReset)resetLocalToFactory(remoteFactoryResetAt);
   if(remoteFactoryResetAt)state.factoryResetAt=remoteFactoryResetAt;

   if(Array.isArray(data.inventory)){
     // V80.1: una respuesta central vacía nunca borra silenciosamente un inventario local válido.
     // El borrado total solo debe ocurrir mediante una operación explícita/versionada.
     if(data.inventory.length || forceFactoryReset || !Array.isArray(state.inventory) || state.inventory.length===0){
       state.inventory=data.inventory;
       normalizeCatalogFields();
       ensureMasterImportOrder();
       state.inventory=orderedProducts(state.inventory);
     }else{
       console.warn("V80.1: inventario central vacío; se conserva el inventario local como medida de seguridad.");
     }
   }
   if(Array.isArray(data.movements))state.movements=data.movements;
   if(Array.isArray(data.counts))state.counts=data.counts;
   if(data.weeklyCounts&&typeof data.weeklyCounts==="object"){
     const localWeek=String(state.weeklyMeta?.label||"");
     const remoteWeek=String(data.weeklyMeta?.label||"");
     state.weeklyCounts=(localWeek&&remoteWeek&&localWeek===remoteWeek)
       ? mergeWeeklyCountsLatest(state.weeklyCounts,data.weeklyCounts)
       : data.weeklyCounts;
   }
   if(data.settings&&typeof data.settings==="object"){
     state.settings={
       name:data.settings.name||"Mi Bodega",
       dark:!!data.settings.dark,
       technicians:Array.isArray(data.settings.technicians)?data.settings.technicians:[],
       keepers:Array.isArray(data.settings.keepers)?data.settings.keepers:[],
       logoDataUrl:typeof data.settings.logoDataUrl==="string"?data.settings.logoDataUrl:""
     };
   }
   if(data.weeklyMeta&&typeof data.weeklyMeta==="object")state.weeklyMeta=data.weeklyMeta;
   if(Array.isArray(data.weeklyHistoryMeta))mergeWeeklyHistoryMeta(data.weeklyHistoryMeta);
   if(data.digitalCounts&&typeof data.digitalCounts==="object")state.digitalCounts=data.digitalCounts;
   if(data.digitalFilter&&typeof data.digitalFilter==="object")state.digitalFilter=data.digitalFilter;
   if(data.digitalClosedFamilies&&typeof data.digitalClosedFamilies==="object")state.digitalClosedFamilies=data.digitalClosedFamilies;
   if(Array.isArray(data.digitalHistory))mergeDigitalHistoryRemote(data.digitalHistory);
   if(Array.isArray(data.digitalAdjustments))state.digitalAdjustments=data.digitalAdjustments;
   if(Array.isArray(data.differenceHistory))mergeDifferenceHistoryRemote(data.differenceHistory);
   if(Array.isArray(data.pendingBaseProducts))state.pendingBaseProducts=data.pendingBaseProducts;
   if(Array.isArray(data.stockoutRecords))state.stockoutRecords=data.stockoutRecords;
   if(data.movementTombstones&&typeof data.movementTombstones==="object")state.movementTombstones=data.movementTombstones;
   if(typeof data.inventoryVersionAt==="string")state.inventoryVersionAt=data.inventoryVersionAt;
   if(typeof data.digitalResetAt==="string")state.digitalResetAt=data.digitalResetAt;
   if(typeof data.factoryResetAt==="string")state.factoryResetAt=data.factoryResetAt;

   if(typeof state.weeklyMeta.active!=="boolean")state.weeklyMeta.active=false;
   if(!Array.isArray(state.weeklyMeta.productIds))state.weeklyMeta.productIds=[];
   if(!Array.isArray(state.weeklyMeta.extraProducts))state.weeklyMeta.extraProducts=[];
   if(typeof state.digitalFilter.responsible!=="string")state.digitalFilter.responsible="";

   normalizeCatalogFields();
   saveLocal();
   return true;
 }finally{
   cloudLoading=false;
 }
}
function weeklyRecordTimeMs(rec){
 const d=parseGTDate(rec?.updatedAt||"");
 return d?d.getTime():0;
}
function mergeWeeklyCountsLatest(localCounts,remoteCounts){
 const out={};
 const keys=new Set([...Object.keys(localCounts||{}),...Object.keys(remoteCounts||{})]);
 keys.forEach(id=>{
   const a=(localCounts||{})[id],b=(remoteCounts||{})[id];
   if(a&&b){
     const am=weeklyRecordTimeMs(a),bm=weeklyRecordTimeMs(b);
     out[id]=(!am||bm>=am)?{...a,...b}:{...b,...a};
   }else if(b)out[id]={...b};
   else if(a)out[id]={...a};
 });
 return out;
}
function normalizeCloudUrl(url){
 return String(url||"").trim().replace(/\/+$/,"");
}
function cloudReady(){
 return !!(normalizeCloudUrl(cloudConfig.url)&&(cloudConfig.proxy||String(cloudConfig.token||"").trim()));
}
function cloudStatusLabel(){
 if(!cloudConfig.enabled)return "Modo local";
 if(cloudConfig.status==="syncing")return "Sincronizando...";
 if(cloudConfig.status==="ok")return cloudConfig.lastSync?`Sincronizado · ${cloudConfig.lastSync}`:"Conectado";
 if(cloudConfig.status==="error")return "Error de conexión";
 return "Google Sheets activado";
}
function updateCloudStatusUI(){
 const el=$("#cloudStatusText");
 if(el)el.textContent=cloudStatusLabel();
 const dot=$("#cloudStatusDot");
 if(dot){
   dot.className="cloud-dot "+(
     !cloudConfig.enabled?"local":
     cloudConfig.status==="ok"?"ok":
     cloudConfig.status==="syncing"?"syncing":
     cloudConfig.status==="error"?"error":"local"
   );
 }
}
function markCloud(status){
 cloudConfig.status=status;
 saveCloudConfig();
 updateCloudStatusUI();
}
function queueCloudSync(delay=900){
 clearTimeout(cloudSyncTimer);
 cloudSyncTimer=setTimeout(async()=>{
   cloudSyncTimer=null;
   const ok=await syncToCloud(true);
   if(!ok&&cloudConfig.enabled&&cloudConfig.autoSync&&cloudReady()){
     clearTimeout(cloudSyncTimer);
     cloudSyncTimer=setTimeout(()=>{cloudSyncTimer=null;syncToCloud(true);},12000);
   }
 },delay);
}
async function cloudJsonp(action,params={}){
 if(!cloudReady())throw new Error(cloudConfig.proxy?"Falta la conexión del servidor.":"Falta URL o token de Google Sheets.");
 const base=normalizeCloudUrl(cloudConfig.url);
 if(cloudConfig.proxy){
   const u=new URL(base,location.href);
   u.searchParams.set("action",action);
   Object.entries(params||{}).forEach(([k,v])=>{if(v!==undefined&&v!==null)u.searchParams.set(k,String(v))});
   u.searchParams.set("_",Date.now());
   const res=await fetch(u.toString(),{method:"GET",cache:"no-store",credentials:"same-origin"});
   const data=await res.json();
   if(!res.ok)throw new Error(data?.error||"Error del servidor Netlify.");
   return data;
 }
 return new Promise((resolve,reject)=>{
   const cb="__bodegaCloud_"+Date.now()+"_"+Math.random().toString(36).slice(2);
   const script=document.createElement("script");
   let done=false;
   const cleanup=()=>{if(done)return;done=true;clearTimeout(timer);try{delete window[cb]}catch{}script.remove()};
   window[cb]=payload=>{cleanup();resolve(payload)};
   const sep=base.includes("?")?"&":"?";
   const extra=Object.entries(params||{}).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>"&"+encodeURIComponent(k)+"="+encodeURIComponent(String(v))).join("");
   script.src=base+sep+"action="+encodeURIComponent(action)+"&token="+encodeURIComponent(cloudConfig.token)+extra+"&callback="+encodeURIComponent(cb)+"&_="+Date.now();
   script.onerror=()=>{cleanup();reject(new Error("No se pudo conectar con Google Sheets."))};
   const timer=setTimeout(()=>{cleanup();reject(new Error("Tiempo de espera agotado."))},20000);
   document.head.appendChild(script);
 });
}

const LIVE_POLL_MS=1200;
const LIVE_DEVICE_KEY="b34_live_device_id";
const LIVE_CURSOR_KEY="b34_live_cursor";
const liveDeviceId=localStorage.getItem(LIVE_DEVICE_KEY)||uid();
localStorage.setItem(LIVE_DEVICE_KEY,liveDeviceId);
const liveState={
 cursor:Number(localStorage.getItem(LIVE_CURSOR_KEY)||0)||0,
 timer:null,
 polling:false,
 initialized:false,
 lastOk:0,
 lastEventAt:0,
 error:""
};
const liveDigitalTimers=new Map();
const liveDigitalPending=new Set();
const liveWeeklyTimers=new Map();
const liveWeeklyPending=new Set();
const liveWeeklyPatches=new Map();
let liveRenderPending=false;

function liveRealtimeReady(){
 return false; // V69: sin modo tiempo real; usa sincronización automática estable con Google Sheets.
}
function setLiveCursor(v){
 const n=Number(v||0)||0;
 if(n>liveState.cursor){
   liveState.cursor=n;
   localStorage.setItem(LIVE_CURSOR_KEY,String(n));
 }
}
function updateLiveStatusUI(){
 const pill=$("#liveStatusPill"),txt=$("#liveStatusText");
 if(!pill||!txt)return;
 const show=!!(cloudConfig.enabled&&cloudReady()&&cloudConfig.autoSync);
 pill.hidden=!show;
 if(!show)return;
 pill.classList.remove("ok","syncing","error");
 if(cloudConfig.status==="syncing"||centralAutoChecking){
   pill.classList.add("syncing");txt.textContent="Auto Sync · sincronizando";
 }else if(cloudConfig.status==="error"||centralLastError){
   pill.classList.add("error");txt.textContent="Auto Sync · reintentando";
 }else{
   pill.classList.add("ok");
   const secs=centralLastOk?Math.max(0,Math.round((Date.now()-centralLastOk)/1000)):0;
   txt.textContent=secs&&secs>8?`Auto Sync · ${secs} s`:`Auto Sync · al día`;
 }
}
setInterval(updateLiveStatusUI,1500);

async function cloudPostAction(action,payload={}){
 if(!cloudConfig.enabled||!cloudReady())throw new Error("Google Sheets no está conectado.");
 const body={action,token:"",deviceId:liveDeviceId,...payload};
 const res=await fetch(normalizeCloudUrl(cloudConfig.url),{
   method:"POST",
   headers:{"Content-Type":"text/plain;charset=utf-8"},
   body:JSON.stringify(body),
   cache:"no-store",
   credentials:"same-origin"
 });
 let data={};
 try{data=await res.json()}catch{}
 if(!res.ok||!data?.ok)throw new Error(data?.error||"No se pudo guardar el cambio.");
 if(data.seq)setLiveCursor(data.seq);
 return data;
}
function applyLiveProductStock(s){
 if(!s||!s.code)return false;
 const p=productByCode(s.code)||state.inventory.find(x=>x.id===s.id);
 if(!p)return false;
 const localMs=Date.parse(p.stockUpdatedAt||0)||0;
 const remoteMs=Date.parse(s.stockUpdatedAt||0)||0;
 if(remoteMs&&localMs>remoteMs)return false;
 p.stock=Number(s.stock||0);
 p.reorder=Number(s.reorder||Math.max(0,Number(p.max||0)-Number(p.stock||0)));
 p.stockUpdatedAt=s.stockUpdatedAt||new Date().toISOString();
 // Mantener Sin Existencia actualizado también con eventos.
 try{syncStockoutRecordsFromInventory("Actualización en vivo");}catch{}
 return true;
}
function applyLiveMovementUpsert(m){
 if(!m?.id)return false;
 const tomb=Date.parse(state.movementTombstones?.[m.id]||0)||0;
 const remote=Date.parse(m.updatedAt||m.createdAt||0)||0;
 if(tomb&&tomb>=remote)return false;
 const i=state.movements.findIndex(x=>x.id===m.id);
 if(i<0){state.movements.push(m);return true;}
 const local=Date.parse(state.movements[i].updatedAt||state.movements[i].createdAt||0)||0;
 if(!local||remote>=local){state.movements[i]={...state.movements[i],...m};return true;}
 return false;
}
function applyLiveMovementDelete(id,deletedAt){
 if(!id)return false;
 const ts=deletedAt||new Date().toISOString();
 state.movementTombstones[id]=ts;
 const before=state.movements.length;
 state.movements=state.movements.filter(x=>x.id!==id);
 return state.movements.length!==before;
}
function applyLiveDigitalRecord(rec){
 if(!rec?.productId)return false;
 if(liveDigitalPending.has(rec.productId))return false;
 const resetMs=Date.parse(state.digitalResetAt||0)||0;
 const remoteMs=Date.parse(rec.updatedAt||0)||0;
 if(resetMs&&remoteMs&&remoteMs<=resetMs)return false;
 const local=state.digitalCounts[rec.productId]||{};
 const localMs=Date.parse(local.updatedAt||0)||0;
 if(localMs&&remoteMs&&localMs>remoteMs)return false;
 state.digitalCounts[rec.productId]={...local,...rec};
 return true;
}
function refreshDigitalLiveRow(productId){
 const p=state.inventory.find(x=>x.id===productId);
 if(!p)return;
 const c=digitalCountState(productId);
 const physical=$(`[data-digital-physical="${CSS.escape(productId)}"]`);
 const obs=$(`[data-digital-obs="${CSS.escape(productId)}"]`);
 if(physical&&document.activeElement!==physical)physical.value=c.physical===""?"":c.physical;
 if(obs&&document.activeElement!==obs)obs.value=c.obs||"";
 const st=digitalStatus(p,c.physical);
 const status=$(`[data-digital-status="${CSS.escape(productId)}"]`);
 if(status){status.textContent=st.text;status.className=`chip ${st.cls}`;}
}
function safeLiveRender(){
 const ae=document.activeElement;
 const editing=ae&&(["INPUT","SELECT","TEXTAREA"].includes(ae.tagName));
 if(editing){liveRenderPending=true;return;}
 liveRenderPending=false;
 render();
}
document.addEventListener("focusout",()=>{
 if(liveRenderPending)setTimeout(()=>{if(!["INPUT","SELECT","TEXTAREA"].includes(document.activeElement?.tagName||""))safeLiveRender();},30);
});
function applyLiveEvent(ev){
 if(!ev||!ev.type)return false;
 let changed=false;
 const payload=ev.payload||{};
 if(ev.type==="digital_upsert"){
   changed=applyLiveDigitalRecord(payload.record||payload);
   if(changed&&state.page==="digital")refreshDigitalLiveRow((payload.record||payload).productId);
   if(changed&&state.page==="diferencias")safeLiveRender();
 }else if(ev.type==="weekly_upsert"){
   const rec=payload.record||payload;
   changed=applyLiveWeeklyRecord(rec,payload.weekLabel||"");
   if(changed&&state.page==="conteo")refreshWeeklyLiveRow(rec.productId);
 }else if(ev.type==="movement_upsert"){
   changed=applyLiveMovementUpsert(payload.movement||payload)||changed;
   changed=applyLiveProductStock(payload.product)||changed;
   if(changed&&["salida","inventario","inicio","sinexist"].includes(state.page))safeLiveRender();
 }else if(ev.type==="movement_delete"){
   changed=applyLiveMovementDelete(payload.id,payload.deletedAt)||changed;
   changed=applyLiveProductStock(payload.product)||changed;
   if(changed&&["salida","inventario","inicio","sinexist"].includes(state.page))safeLiveRender();
 }
 if(changed){
   liveState.lastEventAt=Date.now();
   saveLocal();
 }
 return changed;
}
function setCentralRevision(value){
 const v=String(value||"");
 if(!v)return;
 centralRevision=v;
 localStorage.setItem(CENTRAL_REVISION_KEY,v);
}
function centralUserEditing(){
 const el=document.activeElement;
 if(!el)return false;
 return ["INPUT","TEXTAREA","SELECT"].includes(el.tagName)||!!el.closest?.("dialog[open]");
}
async function pollLiveEvents(force=false){
 if(centralAutoChecking||document.visibilityState==="hidden"||!cloudConfig.enabled||!cloudConfig.autoSync||!cloudReady())return false;
 if(cloudSyncing||cloudSyncTimer)return false;
 if(!force&&centralUserEditing())return false;
 if(hasUnsyncedLocalChanges()){queueCloudSync(250);return false;}
 centralAutoChecking=true;updateLiveStatusUI();
 try{
   const r=await cloudJsonp("revision");
   if(!r||!r.ok)throw new Error(r?.error||"No se pudo revisar la base central.");
   centralLastOk=Date.now();centralLastError="";
   const remote=String(r.revision||"");
   if(remote&&remote!==centralRevision){
     const sx=window.scrollX,sy=window.scrollY;
     const ok=await syncFromCloud(true);
     if(ok){setCentralRevision(remote);requestAnimationFrame(()=>window.scrollTo(sx,sy));}
   }
   return true;
 }catch(err){
   centralLastError=String(err?.message||err);
   console.warn("Auto Sync central:",err);
   return false;
 }finally{
   centralAutoChecking=false;updateLiveStatusUI();
 }
}
async function initializeLiveSync(){
 if(!cloudConfig.enabled||!cloudConfig.autoSync||!cloudReady())return false;
 startLivePolling();
 return pollLiveEvents(true);
}
function startLivePolling(){
 clearInterval(centralAutoTimer);
 if(!cloudConfig.enabled||!cloudConfig.autoSync||!cloudReady())return;
 centralAutoTimer=setInterval(()=>pollLiveEvents(false),AUTO_CENTRAL_CHECK_MS);
}
function stopLivePolling(){clearInterval(centralAutoTimer);centralAutoTimer=null;}


function applyLiveWeeklyRecord(rec,weekLabel){
 if(!rec?.productId)return false;
 if(weekLabel&&String(state.weeklyMeta?.label||"")!==String(weekLabel))return false;
 if(liveWeeklyPending.has(rec.productId))return false;
 const local=state.weeklyCounts[rec.productId]||{};
 const localMs=weeklyRecordTimeMs(local),remoteMs=weeklyRecordTimeMs(rec);
 if(localMs&&remoteMs&&localMs>remoteMs)return false;
 state.weeklyCounts[rec.productId]={...local,...rec};
 return true;
}
function refreshWeeklyLiveRow(productId){
 if(state.page!=="conteo"||weeklyView!=="current")return;
 const product=[...state.inventory,...weeklyExtraProducts()].find(p=>p.id===productId);
 if(!product)return;
 const c=weeklyCountState(productId);
 const escId=CSS.escape(productId);
 const physical=$(`[data-weekly-physical="${escId}"]`);
 const obs=$(`[data-weekly-obs="${escId}"]`);
 const checkbox=$(`[data-weekly-confirm="${escId}"]`);
 const row=$(`[data-weekly-row="${escId}"]`);
 const locked=!!state.weeklyMeta.closed||!!c.confirmed;
 if(physical&&document.activeElement!==physical){physical.value=c.physical===""?"":c.physical;physical.disabled=locked;}
 if(obs&&document.activeElement!==obs){obs.value=c.obs||"";obs.disabled=locked;}
 if(checkbox&&document.activeElement!==checkbox){checkbox.checked=!!c.confirmed;checkbox.disabled=!!state.weeklyMeta.closed;}
 if(row)row.classList.toggle("weekly-row-confirmed",!!c.confirmed);
 if(product.weeklyOnly&&row){
   row.querySelectorAll("[data-weekly-extra-field]").forEach(el=>{if(document.activeElement!==el)el.disabled=locked;});
 }
 const diff=weeklyDiff(product,c.physical),st=weeklyStatus(product,c.physical);
 const diffEl=$(`[data-weekly-diff="${escId}"]`),statusEl=$(`[data-weekly-status="${escId}"]`);
 if(diffEl)diffEl.textContent=diff===""?"—":`${diff>0?"+":""}${diff}`;
 if(statusEl){statusEl.textContent=st.text;statusEl.className=`chip ${st.cls}`;}
}
function queueLiveWeeklyPatch(productId,patch={},delay=220){
 if(!liveRealtimeReady()||!state.weeklyMeta.active)return false;
 const existing=liveWeeklyPatches.get(productId)||{};
 liveWeeklyPatches.set(productId,{...existing,...patch});
 clearTimeout(liveWeeklyTimers.get(productId));
 liveWeeklyPending.add(productId);
 const timer=setTimeout(async()=>{
   liveWeeklyTimers.delete(productId);
   const outgoing=liveWeeklyPatches.get(productId)||{};
   liveWeeklyPatches.delete(productId);
   try{
     const r=await cloudPostAction("live_weekly_patch",{
       weekLabel:state.weeklyMeta.label||"",
       productId,
       patch:outgoing
     });
     liveWeeklyPending.delete(productId);
     if(r.record){
       state.weeklyCounts[productId]={...(state.weeklyCounts[productId]||{}),...r.record};
       saveLocal();
       refreshWeeklyLiveRow(productId);
     }
     liveState.lastOk=Date.now();liveState.error="";
   }catch(err){
     liveWeeklyPending.delete(productId);
     liveState.error=String(err?.message||err);
     console.error("Weekly live sync:",err);
     toast("Conteo guardado localmente; reintentando sincronización.");
     saveLocal();
     setTimeout(()=>queueLiveWeeklyPatch(productId,outgoing,250),2500);
   }
 },delay);
 liveWeeklyTimers.set(productId,timer);
 return true;
}
function persistWeeklyPatch(productId,patch,delay=220){
 saveLocal();
 if(liveRealtimeReady())return queueLiveWeeklyPatch(productId,patch,delay);
 save();
 return false;
}

let differenceHistorySyncTimer=null,differenceHistorySyncing=false;

function differenceRecordCloudParams(rec){
 return {
   id:rec.id||"",
   detectedAt:rec.detectedAt||"",
   productId:rec.productId||"",
   code:rec.code||"",
   catalog:rec.catalog||"",
   name:rec.name||"",
   family:rec.family||"",
   expected:Number(rec.expected||0),
   physical:Number(rec.physical||0),
   difference:Number(rec.difference||0),
   responsible:rec.responsible||"",
   obs:rec.obs||"",
   status:rec.status||"open",
   resolvedAt:rec.resolvedAt||"",
   resolution:rec.resolution||"",
   lastCheckedAt:rec.lastCheckedAt||"",
   lastExpected:Number(rec.lastExpected||0),
   lastPhysical:Number(rec.lastPhysical||0),
   lastDifference:Number(rec.lastDifference||0)
 };
}
function markDifferenceDirty(rec){
 if(!rec)return;
 rec.needsSync=true;
 rec.syncError="";
 saveLocal();
 scheduleDifferenceHistorySync();
}
function pendingDifferenceSyncCount(){
 return (state.differenceHistory||[]).filter(r=>r&&r.needsSync!==false).length;
}
function scheduleDifferenceHistorySync(delay=700){
 if(authState.localOnly)return;
 clearTimeout(differenceHistorySyncTimer);
 differenceHistorySyncTimer=setTimeout(()=>syncDifferenceHistoryQueue(false),delay);
}
async function saveDifferenceRecordToSheets(rec){
 const r=await cloudJsonp("save_difference",differenceRecordCloudParams(rec));
 if(!r||!r.ok||!r.saved){
   throw new Error(r?.error||"Google Sheets no confirmó la diferencia.");
 }
 if(r.id&&r.id!==rec.id)throw new Error("La confirmación de Google Sheets no coincide con el registro.");
 rec.needsSync=false;
 rec.lastSyncedAt=new Date().toISOString();
 rec.syncError="";
 return true;
}
async function syncDifferenceHistoryQueue(blocking=false){
 if(differenceHistorySyncing)return false;
 const pending=(state.differenceHistory||[]).filter(r=>r&&r.needsSync!==false);
 if(!pending.length)return true;
 if(authState.localOnly||!cloudConfig.enabled||!cloudReady())return false;

 differenceHistorySyncing=true;
 let ok=true;
 try{
   for(const rec of pending){
     try{
       await saveDifferenceRecordToSheets(rec);
       saveLocal();
     }catch(err){
       ok=false;
       rec.needsSync=true;
       rec.syncError=String(err?.message||"Error de sincronización");
       saveLocal();
       if(blocking)break;
     }
   }
 }finally{
   differenceHistorySyncing=false;
 }
 if(!ok&&!blocking)scheduleDifferenceHistorySync(12000);
 return ok && pendingDifferenceSyncCount()===0;
}
function mergeDifferenceHistoryRemote(remote){
 if(!Array.isArray(remote))return;
 if(!Array.isArray(state.differenceHistory))state.differenceHistory=[];

 const byId=new Map(state.differenceHistory.map(r=>[r.id,r]));
 remote.forEach(rr=>{
   if(!rr?.id)return;
   const local=byId.get(rr.id);
   if(!local){
     const copy={...rr,needsSync:false,lastSyncedAt:new Date().toISOString(),syncError:""};
     state.differenceHistory.push(copy);
     byId.set(copy.id,copy);
     return;
   }
   if(local.needsSync===true)return;

   const lt=new Date(local.lastCheckedAt||local.resolvedAt||local.detectedAt||0).getTime()||0;
   const rt=new Date(rr.lastCheckedAt||rr.resolvedAt||rr.detectedAt||0).getTime()||0;
   if(rt>=lt){
     Object.assign(local,rr,{needsSync:false,lastSyncedAt:new Date().toISOString(),syncError:""});
   }
 });
}

async function getDifferenceHistoryFromSheets(){
 if(!cloudReady())return [];
 const r=await cloudJsonp("difference_history");
 if(!r||!r.ok)throw new Error(r?.error||"No se pudo leer el historial de diferencias.");
 return Array.isArray(r.history)?r.history:[];
}
async function recoverDifferenceHistoryFromSheets(silent=true){
 try{
   const remote=await getDifferenceHistoryFromSheets();
   if(!remote.length)return false;
   mergeDifferenceHistoryRemote(remote);
   saveLocal();
   if(!silent)toast(`Historial central: ${remote.length} diferencia(s).`);
   return true;
 }catch(err){
   console.error(err);
   if(!silent)toast(err?.message||"No se pudo recuperar el historial.");
   return false;
 }
}
async function getCentralStaff(){
 if(!cloudReady())throw new Error("Google Sheets no está conectado.");
 const r=await cloudJsonp("staff");
 if(!r||!r.ok)throw new Error(r?.error||"No se pudo leer el personal central.");
 return {
   technicians:Array.isArray(r.technicians)?r.technicians.filter(Boolean):[],
   keepers:Array.isArray(r.keepers)?r.keepers.filter(Boolean):[]
 };
}
async function syncCentralStaff(silent=true){
 try{
   const staff=await getCentralStaff();
   state.settings.technicians=[...new Set(staff.technicians.map(x=>String(x).trim()).filter(Boolean))];
   state.settings.keepers=[...new Set(staff.keepers.map(x=>String(x).trim()).filter(Boolean))];
   saveLocal();
   if(!silent)toast(`Personal cargado: ${state.settings.technicians.length} técnico(s) · ${state.settings.keepers.length} bodeguero(s).`);
   return true;
 }catch(err){
   console.error(err);
   if(!silent)toast(err?.message||"No se pudo cargar el personal central.");
   return false;
 }
}
async function setCentralStaffEntry(type,name,active=true){
 const clean=String(name||"").trim();
 if(!clean)throw new Error("Nombre vacío.");
 const r=await cloudJsonp("save_staff",{type,name:clean,active:active?"1":"0"});
 if(!r||!r.ok||!r.saved)throw new Error(r?.error||"No se pudo guardar el personal en Google Sheets.");
 await syncCentralStaff(true);
 return true;
}
async function testCloudConnection(showToast=true){
 if(!cloudReady()){
   if(showToast)toast("Ingresa la URL Web App y el token.");
   return false;
 }
 markCloud("syncing");
 try{
   const r=await cloudJsonp("ping");
   if(!r||!r.ok)throw new Error(r?.error||"Respuesta inválida.");
   if(r.revision)setCentralRevision(r.revision);
   centralLastOk=Date.now();centralLastError="";
   cloudConfig.lastSync=new Date().toLocaleString("es-GT");
   markCloud("ok");
   await syncCentralStaff(true);
   if(showToast)toast("Conexión central correcta. Personal y datos listos.");
   if(state.baseProductSyncQueue?.length)scheduleBaseProductQueueSync(400);
   return true;
 }catch(err){
   console.error(err);
   markCloud("error");
   if(showToast)toast(err?.message||"No se pudo conectar con Google Sheets.");
   return false;
 }
}
async function syncFromCloud(silent=false){
 if(!cloudReady()){
   if(!silent)toast("Configura Google Sheets primero.");
   return false;
 }
 if(cloudSyncing)return false;
 cloudSyncing=true;
 markCloud("syncing");
 try{
   const r=await cloudJsonp("load");
   if(!r||!r.ok)throw new Error(r?.error||"No se pudo leer la base de datos.");
   if(r.revision)setCentralRevision(r.revision);
   centralLastOk=Date.now();centralLastError="";
   if(r.data){
     applyCloudSnapshot(r.data);
     await syncCentralStaff(true);
     cloudConfig.lastSync=new Date().toLocaleString("es-GT");
     markCloud("ok");
     document.body.classList.toggle("dark",state.settings.dark);
     applyBranding();
     render();
     if(!silent)toast("Datos descargados desde Google Sheets.");
   }else{
     await syncCentralStaff(true);
     markCloud("ok");
     render();
     if(!silent)toast("La base operativa está vacía; el personal central sí fue cargado.");
   }
   return true;
 }catch(err){
   console.error(err);
   markCloud("error");
   if(!silent)toast(err?.message||"Error al descargar datos de Google Sheets.");
   return false;
 }finally{
   cloudSyncing=false;
 }
}
async function syncToCloud(silent=false){
 if(!cloudConfig.enabled||!cloudReady()){
   if(!silent)toast("Activa y configura Google Sheets.");
   return false;
 }
 if(cloudSyncing){if(!silent)toast("Ya hay una sincronización en proceso.");return false}
 const serialAtStart=localChangeSerial;
 cloudSyncing=true;markCloud("syncing");
 try{
   const payload={action:"save",token:cloudConfig.proxy?"":cloudConfig.token,data:cloudSnapshot()};
   const opts={method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify(payload)};
   if(cloudConfig.proxy)opts.credentials="same-origin"; else opts.mode="no-cors";
   const res=await fetch(normalizeCloudUrl(cloudConfig.url),opts);
   if(cloudConfig.proxy){
     const data=await res.json();
     if(!res.ok||!data?.ok)throw new Error(data?.error||"No se pudo guardar en el servidor.");
     if(data.revision)setCentralRevision(data.revision);
   }else{
     let confirmed=false;
     for(let attempt=0;attempt<3&&!confirmed;attempt++){
       await new Promise(r=>setTimeout(r,700+attempt*500));
       try{
         const check=await cloudJsonp("load");
         confirmed=!!(check?.ok&&check?.data?.savedAt===payload.data.savedAt);
         if(check?.revision)setCentralRevision(check.revision);
       }catch{}
     }
     if(!confirmed)throw new Error("Google Sheets no confirmó el guardado. Revisa URL, token o implementación.");
   }
   lastPushedSerial=Math.max(lastPushedSerial,serialAtStart);
   if(localChangeSerial===serialAtStart)markLocalChangesSynced();
   centralLastOk=Date.now();centralLastError="";
   cloudConfig.lastSync=new Date().toLocaleString("es-GT");markCloud("ok");
   if(pendingDigitalArchiveCount())setTimeout(()=>syncDigitalArchiveQueue(false),250);
   if(!silent)toast("Datos guardados en Google Sheets.");
   return true;
 }catch(err){
   centralLastError=String(err?.message||err);
   console.error(err);markCloud("error");if(!silent)toast("Error al guardar en Google Sheets. Se reintentará automáticamente.");return false;
 }finally{cloudSyncing=false;updateLiveStatusUI();}
}

function toast(t){let e=$("#toast");e.textContent=t;e.classList.add("show");setTimeout(()=>e.classList.remove("show"),2100)}
function stockoutCode(v){
 return String(v||"").trim().toUpperCase();
}
function activeStockoutForCode(code){
 const q=stockoutCode(code);
 return (state.stockoutRecords||[]).find(r=>r.active&&stockoutCode(r.code)===q)||null;
}
function syncStockoutRecordsFromInventory(source="Sistema"){
 if(!Array.isArray(state.stockoutRecords))state.stockoutRecords=[];
 const now=new Date().toISOString();

 state.inventory.forEach(p=>{
   const code=stockoutCode(p.code);
   if(!code)return;
   const active=activeStockoutForCode(code);
   const stock=Number(p.stock||0);

   if(stock<=0){
     if(!active){
       state.stockoutRecords.push({
         id:uid(),
         productId:p.id,
         code:p.code||"",
         catalog:p.catalog||"",
         name:p.name||"",
         family:p.family||"",
         min:Number(p.min||0),
         max:Number(p.max||0),
         location:p.location||"",
         detectedAt:now,
         active:true,
         resolvedAt:"",
         source
       });
     }else{
       active.productId=p.id;
       active.catalog=p.catalog||active.catalog||"";
       active.name=p.name||active.name||"";
       active.family=p.family||active.family||"";
       active.min=Number(p.min||active.min||0);
       active.max=Number(p.max||active.max||0);
       active.location=p.location||active.location||"";
     }
   }else if(active){
     active.active=false;
     active.resolvedAt=now;
   }
 });
}
function stockoutDateTime(iso){
 if(!iso)return {date:"—",time:"—"};
 const d=new Date(iso);
 if(Number.isNaN(d.getTime()))return {date:"—",time:"—"};
 return {
   date:d.toLocaleDateString("es-GT",{day:"2-digit",month:"2-digit",year:"numeric"}),
   time:d.toLocaleTimeString("es-GT",{hour:"2-digit",minute:"2-digit",second:"2-digit"})
 };
}
function normalizeMasterOrderValue(v,fallback=999999999){
 const n=Number(v);
 return Number.isFinite(n)&&n>=0?n:fallback;
}
function ensureMasterImportOrder(){
 if(!Array.isArray(state.inventory))return;
 let next=1;
 state.inventory.forEach((p,i)=>{
   if(Number.isFinite(Number(p.importOrder))&&Number(p.importOrder)>=0){
     next=Math.max(next,Number(p.importOrder)+1);
   }
 });
 state.inventory.forEach((p,i)=>{
   if(!Number.isFinite(Number(p.importOrder))||Number(p.importOrder)<0){
     p.importOrder=next++;
   }
 });
}
function orderedProducts(items){
 const list=Array.isArray(items)?[...items]:[];
 const originalIndex=new Map();
 list.forEach((p,i)=>originalIndex.set(p?.id||p,i));
 return list.sort((a,b)=>{
   const ao=normalizeMasterOrderValue(a?.importOrder);
   const bo=normalizeMasterOrderValue(b?.importOrder);
   if(ao!==bo)return ao-bo;
   return (originalIndex.get(a?.id||a)??0)-(originalIndex.get(b?.id||b)??0);
 });
}
function nextMasterImportOrder(){
 ensureMasterImportOrder();
 return state.inventory.reduce((m,p)=>Math.max(m,normalizeMasterOrderValue(p.importOrder,0)),0)+1;
}
function status(p){if(+p.stock===0)return '<span class="chip zero">Sin existencia</span>';if(+p.stock<=+p.min)return '<span class="chip low">Stock bajo</span>';return '<span class="chip ok">Disponible</span>'}
function dashboardDifferenceCount(){
 const keys=new Set();
 (state.differenceHistory||[]).forEach(rec=>{
   if(!differenceRecordOpen(rec))return;
   const key=String(rec.productId||normalizeImportCode(rec.code)||rec.id||"").trim();
   if(key)keys.add(key);
 });
 state.inventory.forEach(p=>{
   const c=state.digitalCounts?.[p.id];
   if(!c||c.physical===""||c.physical===null||c.physical===undefined)return;
   if(digitalDiff(p,c.physical)===0)return;
   keys.add(String(p.id||normalizeImportCode(p.code)||""));
 });
 return keys.size;
}
function calc(){return{products:state.inventory.length,units:state.inventory.reduce((a,p)=>a+(+p.stock||0),0),low:state.inventory.filter(p=>p.stock>0&&p.stock<=p.min).length,zero:state.inventory.filter(p=>+p.stock===0).length,diffs:dashboardDifferenceCount()}}
function productByCode(c){let q=String(c||"").trim().toLowerCase();return state.inventory.find(p=>String(p.code).trim().toLowerCase()===q)}
function options(arr){return arr.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join("")}
function productRows(items=state.inventory){
 items=orderedProducts(items);
 if(!items.length)return `<tr><td colspan="11"><div class="empty">No hay productos.</div></td></tr>`;
 return items.map(p=>`<tr>
 <td><div class="table-actions"><button class="mini-action" data-view-product="${p.id}" title="Ver detalle">◉</button></div></td>
 <td><b>${esc(p.code)}</b></td><td>${esc(p.catalog||"—")}</td><td>${esc(p.name)}</td><td>${esc(p.family||"—")}</td>
 <td class="qty">${p.stock}</td><td>${p.min}</td><td>${p.max}</td><td>${esc(p.location||"—")}</td><td>${p.reorder??Math.max(0,(+p.max||0)-(+p.stock||0))}</td><td>${status(p)}</td></tr>`).join("")
}
function inventoryTable(items=state.inventory){
 items=orderedProducts(items);
 return `<div class="table-wrap inventory-table-wrap">
   <table class="inventory-table" aria-label="Inventario">
     <colgroup>
       <col class="col-action">
       <col class="col-code">
       <col class="col-catalog">
       <col class="col-description">
       <col class="col-family">
       <col class="col-stock">
       <col class="col-min">
       <col class="col-max">
       <col class="col-location">
       <col class="col-reorder">
       <col class="col-status">
     </colgroup>
     <thead>
       <tr>
         <th>Acc.</th>
         <th>Código</th>
         <th>Catálogo</th>
         <th>Descripción</th>
         <th>Familia</th>
         <th>Exist.</th>
         <th>Mín.</th>
         <th>Máx.</th>
         <th>Ubicación</th>
         <th>Reposición</th>
         <th>Estado</th>
       </tr>
     </thead>
     <tbody>${productRows(items)}</tbody>
   </table>
 </div>`;
}
function orderIsLocked(m){
  if(typeof m.orderLocked === "boolean") return m.orderLocked;
  return !!String(m.orderNumber || "").trim();
}
function movementTable(){
 if(!state.movements.length)return `<div class="empty">Aún no hay salidas registradas.</div>`;
 return `<div class="table-wrap"><table class="movement-table"><thead><tr><th>Fecha</th><th>Código</th><th>Cantidad</th><th>Técnico</th><th>N. de Orden</th><th>Estado</th><th>Bodeguero</th><th>Acc.</th></tr></thead><tbody>
 ${state.movements.slice().reverse().map(m=>{
   const hasOrder=!!String(m.orderNumber||"").trim();
   const locked=orderIsLocked(m);
   return `<tr>
 <td>${esc(m.date)}</td><td><b>${esc(m.code)}</b></td><td class="qty">${m.qty}</td><td>${esc(m.technician)}</td>
 <td>
   <div class="order-cell">
     <input class="order-input ${locked?"order-locked":""}" data-order="${m.id}" placeholder="Ingresar orden"
            value="${esc(m.orderNumber||"")}" ${locked?"readonly":""} aria-label="Número de orden">
     ${locked?'<span class="order-lock-mark" title="Número de orden bloqueado">🔒</span>':""}
   </div>
 </td>
 <td><span class="chip ${hasOrder?"downloaded":"pending"}" data-mstatus="${m.id}">${hasOrder?"Descargado":"PEND. DESCARGA"}</span></td>
 <td>${esc(m.keeper)}</td><td><div class="table-actions movement-actions">
 <button class="mini-action" data-view-movement="${m.id}" title="Ver detalle" aria-label="Ver detalle">◉</button>
 <button class="mini-action" data-edit-movement="${m.id}" title="Editar cantidad" aria-label="Editar cantidad">✎</button>
 <button class="mini-action delete-action" data-delete-movement="${m.id}" title="Eliminar salida" aria-label="Eliminar salida">🗑</button>
 <button class="mini-action lock-action ${locked?"unlock-ready":"lock-ready"}" data-toggle-order-lock="${m.id}"
         title="${locked?"Desbloquear N. de Orden":hasOrder?"Bloquear N. de Orden":"Sin N. de Orden"}"
         aria-label="${locked?"Desbloquear N. de Orden":hasOrder?"Bloquear N. de Orden":"Sin N. de Orden"}"
         ${!locked&&!hasOrder?"disabled":""}>${locked?"🔓":"🔒"}</button>
 </div></td></tr>`;
 }).join("")}</tbody></table></div>`
}
function renderInicio(){
 let s=calc();return `<div class="hero"><section class="hero-a"><div><small>RESUMEN DE HOY</small><h2>Todo tu inventario, claro y rápido.</h2><p>Controla existencias, registra salidas y detecta diferencias desde el celular o la computadora.</p></div><div class="actions"><button class="btn primary" data-go="salida">⇥ Registrar salida</button><button class="btn tonal" data-new-product>＋ Nuevo producto</button></div></section><section class="hero-b"><div><small>UNIDADES DISPONIBLES</small><div class="big">${s.units}</div></div><small>${s.products} productos registrados · ${s.low} con stock bajo</small></section></div>
 <div class="stats dashboard-stats">
   <div class="stat"><span class="stat-icon">▣</span><b>${s.products}</b><small>Productos registrados</small></div>
   <div class="stat"><span class="stat-icon">△</span><b>${s.low}</b><small>Stock bajo</small></div>
   <div class="stat"><span class="stat-icon">!</span><b>${s.zero}</b><small>Sin existencia</small></div>
   <button type="button" class="stat stat-action stat-differences ${s.diffs>0?"has-pending":"is-clear"}" data-go="diferencias" aria-label="Abrir diferencias de Inventario Digital">
     <span class="stat-icon">≠</span><b>${s.diffs}</b><small>Diferencias pendientes</small><span class="stat-cta">${s.diffs>0?"Revisar pendientes →":"Sin pendientes · Ver historial →"}</span>
   </button>
 </div>
 <section class="panel attention-panel"><div class="panel-head"><div><h2>Productos que requieren atención</h2><p>Stock bajo o sin existencia.</p></div><button class="btn tonal" data-go="inventario">Ver inventario</button></div>${inventoryTable(state.inventory.filter(p=>+p.stock<=+p.min))}</section>`
}
function renderInventario(items=state.inventory){items=orderedProducts(items);return `<section class="panel inventory-panel"><div class="panel-head"><div><h2>Inventario actual</h2><p>${items.length} productos visibles.</p></div><button class="btn primary" data-new-product>＋ Agregar</button></div>${inventoryTable(items)}</section>`}
function renderSalida(){return `<section class="form-card"><small>MOVIMIENTO</small><h2>Registrar salida</h2><p class="hint">Formulario compacto para registrar salidas de inventario.</p><form id="exitForm" autocomplete="off"><div class="form-grid">
 <label class="autocomplete">Código<input id="exitCode" required placeholder="Escribe el código..." spellcheck="false"><div id="suggestions" class="suggestions" hidden></div><small id="codeInfo" class="hint">Sugerencias automáticas por código.</small></label>
 <label>Cantidad<input id="exitQty" class="no-spinner" type="number" inputmode="numeric" min="1" step="1" value="" placeholder="0" required></label>
 <label>Técnico<select id="exitTech" required><option value="">Selecciona técnico...</option>${options(state.settings.technicians)}</select></label>
 <label>Bodeguero<select id="exitKeeper" required><option value="">Selecciona bodeguero...</option>${options(state.settings.keepers)}</select></label>
 </div><div class="actions" style="margin-top:14px"><button class="btn primary">✓ Guardar salida</button></div></form></section>
 <section class="panel compact-movement-panel"><div class="panel-head"><div><h2>Salidas registradas</h2><p>N. de Orden editable y estado automático.</p></div></div>${movementTable()}</section>`}
function weeklyArchiveHash(text){
 let h=2166136261;
 const s=String(text||"");
 for(let i=0;i<s.length;i++){
   h^=s.charCodeAt(i);
   h=Math.imul(h,16777619);
 }
 return (h>>>0).toString(16).padStart(8,"0");
}
function weeklyMetaSort(items){
 return [...(items||[])].sort((a,b)=>{
   const ad=new Date(a.closedAt||0).getTime()||0;
   const bd=new Date(b.closedAt||0).getTime()||0;
   return bd-ad;
 });
}
function mergeWeeklyHistoryMeta(remote){
 if(!Array.isArray(remote))return;
 if(!Array.isArray(state.weeklyHistoryMeta))state.weeklyHistoryMeta=[];
 const byId=new Map(state.weeklyHistoryMeta.map(m=>[m.id,m]));
 remote.forEach(r=>{
   if(!r?.id)return;
   const local=byId.get(r.id);
   if(!local){
     state.weeklyHistoryMeta.push({...r,needsSync:false});
     byId.set(r.id,state.weeklyHistoryMeta[state.weeklyHistoryMeta.length-1]);
   }else if(local.needsSync!==true){
     Object.assign(local,r,{needsSync:false});
   }
 });
}
function currentWeeklyArchiveMeta(){
 const id=state.weeklyMeta?.lastArchiveId||"";
 return (state.weeklyHistoryMeta||[]).find(m=>m.id===id)||null;
}
function pendingWeeklyArchiveCount(){
 return (state.weeklyArchiveQueue||[]).length;
}
function weeklyArchiveStatusText(item){
 if(item.physical===""||item.physical===null||item.physical===undefined)return "Pendiente";
 const d=Number(item.difference||0);
 return d===0?"Cuadreado":d>0?"Sobrante":"Faltante";
}
function buildWeeklyArchiveSnapshot(){
 if(!state.weeklyMeta.active)return null;
 const products=weeklySelectedProducts();
 if(!products.length)return null;

 const now=new Date().toISOString();
 const sameLabel=(state.weeklyHistoryMeta||[]).filter(m=>m.label===state.weeklyMeta.label);
 const revision=sameLabel.length+1;

 const items=products.map((p,index)=>{
   const c=weeklyCountState(p.id);
   const physical=c.physical;
   const expected=weeklyExpectedStock(p);
   const difference=physical===""?null:Number(physical)-expected;
   return {
     order:index+1,
     productId:p.id||"",
     code:p.code||"",
     catalog:p.catalog||"",
     name:p.name||"",
     family:p.family||"",
     expected,
     physical:physical===""?"":Number(physical),
     confirmed:!!c.confirmed,
     confirmedAt:c.confirmedAt||"",
     confirmedBy:c.confirmedBy||"",
     difference,
     status:physical===""?"Pendiente":difference===0?"Cuadreado":difference>0?"Sobrante":"Faltante",
     obs:c.obs||"",
     weeklyOnly:!!p.weeklyOnly
   };
 });

 const counted=items.filter(i=>i.physical!=="").length;
 const differences=items.filter(i=>i.physical!==""&&Number(i.difference)!==0).length;
 const pending=items.length-counted;
 const id=uid();
 const checksum=weeklyArchiveHash(JSON.stringify(items));

 return {
   id,
   label:state.weeklyMeta.label||"",
   responsible:state.weeklyMeta.responsible||"",
   closedAt:now,
   revision,
   itemCount:items.length,
   counted,
   differences,
   pending,
   checksum,
   items
 };
}
function addWeeklyArchiveLocal(archive){
 if(!archive)return;
 if(!Array.isArray(state.weeklyHistoryMeta))state.weeklyHistoryMeta=[];
 if(!Array.isArray(state.weeklyArchiveQueue))state.weeklyArchiveQueue=[];

 const meta={
   id:archive.id,
   label:archive.label,
   responsible:archive.responsible,
   closedAt:archive.closedAt,
   revision:archive.revision,
   itemCount:archive.itemCount,
   counted:archive.counted,
   differences:archive.differences,
   pending:archive.pending,
   checksum:archive.checksum,
   needsSync:true
 };

 state.weeklyHistoryMeta.push(meta);
 state.weeklyArchiveQueue.push(archive);
 state.weeklyMeta.lastArchiveId=archive.id;
 state.weeklyMeta.closedAt=archive.closedAt;
 saveLocal();
}
function weeklyHistoryMetaById(id){
 return (state.weeklyHistoryMeta||[]).find(m=>m.id===id)||null;
}
function weeklyArchiveQueuedById(id){
 return (state.weeklyArchiveQueue||[]).find(a=>a.id===id)||null;
}
async function verifyWeeklyArchiveSaved(archive){
 const r=await cloudJsonp("week_history_status",{id:archive.id});
 return !!(
   r?.ok &&
   r?.saved &&
   String(r.id||"")===String(archive.id) &&
   Number(r.itemCount||0)===Number(archive.itemCount||0) &&
   String(r.checksum||"")===String(archive.checksum||"")
 );
}
async function saveWeeklyArchiveToSheets(archive){
 if(!archive)throw new Error("Archivo semanal vacío.");
 if(!cloudConfig.enabled||!cloudReady())throw new Error("Google Sheets no está conectado.");

 const payload={
   action:"save_week_archive",
   token:cloudConfig.proxy?"":cloudConfig.token,
   archive
 };
 const opts={
   method:"POST",
   headers:{"Content-Type":"text/plain;charset=utf-8"},
   body:JSON.stringify(payload)
 };
 if(cloudConfig.proxy)opts.credentials="same-origin"; else opts.mode="no-cors";

 const res=await fetch(normalizeCloudUrl(cloudConfig.url),opts);
 if(cloudConfig.proxy){
   const data=await res.json();
   if(!res.ok||!data?.ok)throw new Error(data?.error||"No se pudo guardar el historial semanal.");
 }

 let confirmed=false;
 for(let attempt=0;attempt<4&&!confirmed;attempt++){
   await new Promise(r=>setTimeout(r,700+attempt*500));
   try{confirmed=await verifyWeeklyArchiveSaved(archive)}catch{}
 }
 if(!confirmed)throw new Error("Google Sheets no confirmó el Historial de Conteo Semanal.");
 return true;
}
async function syncWeeklyArchiveQueue(blocking=false){
 if(!state.weeklyArchiveQueue.length)return true;
 if(authState.localOnly||!cloudConfig.enabled||!cloudReady())return false;

 const queue=[...state.weeklyArchiveQueue];
 for(const archive of queue){
   try{
     await saveWeeklyArchiveToSheets(archive);
     state.weeklyArchiveQueue=state.weeklyArchiveQueue.filter(a=>a.id!==archive.id);
     const meta=weeklyHistoryMetaById(archive.id);
     if(meta){
       meta.needsSync=false;
       meta.lastSyncedAt=new Date().toISOString();
       meta.syncError="";
     }
     saveLocal();
   }catch(err){
     const meta=weeklyHistoryMetaById(archive.id);
     if(meta){
       meta.needsSync=true;
       meta.syncError=String(err?.message||"Error de respaldo");
     }
     saveLocal();
     if(blocking)return false;
   }
 }
 return state.weeklyArchiveQueue.length===0;
}
async function recoverWeeklyHistoryList(silent=true){
 try{
   if(!cloudConfig.enabled||!cloudReady())return false;
   const r=await cloudJsonp("week_history_list");
   if(!r?.ok)throw new Error(r?.error||"No se pudo leer el historial semanal.");
   const list=Array.isArray(r.weeks)?r.weeks:[];
   mergeWeeklyHistoryMeta(list);
   saveLocal();
   if(!silent)toast(`Historial semanal: ${list.length} semana(s).`);
   return true;
 }catch(err){
   console.error(err);
   if(!silent)toast(err?.message||"No se pudo recuperar el historial semanal.");
   return false;
 }
}
async function loadWeeklyArchive(id,silent=true){
 if(!id)return null;
 const queued=weeklyArchiveQueuedById(id);
 if(queued){
   weeklyHistoryLoadedArchive=queued;
   return queued;
 }
 try{
   weeklyHistoryLoading=true;
   const r=await cloudJsonp("week_history",{id});
   if(!r?.ok||!r.archive)throw new Error(r?.error||"No se pudo cargar la semana.");
   weeklyHistoryLoadedArchive=r.archive;
   return r.archive;
 }catch(err){
   console.error(err);
   if(!silent)toast(err?.message||"No se pudo cargar la semana.");
   return null;
 }finally{
   weeklyHistoryLoading=false;
 }
}
function weeklyHistoryTabs(){
 return `<div class="weekly-view-tabs">
   <button class="btn ${weeklyView==="current"?"primary":"tonal"}" data-weekly-view="current">Semana actual</button>
   <button class="btn ${weeklyView==="history"?"primary":"tonal"}" data-weekly-view="history">Historial (${state.weeklyHistoryMeta.length})</button>
 </div>`;
}
function weeklyHistoryTable(archive){
 if(!archive)return `<div class="empty">Selecciona una semana del historial.</div>`;
 const rows=(archive.items||[]).map(item=>`<tr>
   <td><b>${esc(item.code||"")}</b></td>
   <td>${esc(item.catalog||"—")}</td>
   <td>${esc(item.name||"—")}</td>
   <td>${esc(item.family||"—")}</td>
   <td class="qty">${Number(item.expected||0)}</td>
   <td class="qty">${item.physical===""?"—":Number(item.physical)}</td>
   <td class="weekly-confirm-history">${item.confirmed?`<span class="weekly-confirmed-mark" title="${esc(item.confirmedAt||"")}">✓</span>`:"—"}</td>
   <td class="qty">${item.difference===null||item.difference===undefined?"—":`${Number(item.difference)>0?"+":""}${Number(item.difference)}`}</td>
   <td><span class="chip ${item.status==="Cuadreado"?"count-balanced":item.status==="Sobrante"?"count-surplus":item.status==="Faltante"?"count-shortage":"pending"}">${esc(item.status||"Pendiente")}</span></td>
   <td>${esc(item.obs||"—")}</td>
 </tr>`).join("");
 return `<div class="table-wrap"><table class="weekly-table weekly-history-table">
   <thead><tr><th>Código</th><th>Catálogo</th><th>Descripción</th><th>Familia</th><th>Exist.</th><th>Físico</th><th>✓</th><th>Dif.</th><th>Estado</th><th>Obs.</th></tr></thead>
   <tbody>${rows}</tbody>
 </table></div>`;
}
function renderWeeklyHistory(){
 const metas=weeklyMetaSort(state.weeklyHistoryMeta);
 if(!weeklyHistorySelectedId&&metas.length)weeklyHistorySelectedId=metas[0].id;
 const selected=weeklyHistoryMetaById(weeklyHistorySelectedId);
 const loaded=weeklyHistoryLoadedArchive?.id===weeklyHistorySelectedId?weeklyHistoryLoadedArchive:null;

 return `<section class="panel weekly-panel weekly-history-panel">
   <div class="panel-head weekly-head">
     <div>
       <h2>Historial de Conteo Semanal</h2>
       <p>${metas.length} semana(s) archivada(s) · ${pendingWeeklyArchiveCount()} pendiente(s) de respaldo.</p>
     </div>
     ${weeklyHistoryTabs()}
   </div>
   ${metas.length?`
     <div class="weekly-history-controls">
       <label>Semana archivada
         <select id="weeklyHistorySelect">
           ${metas.map(m=>`<option value="${m.id}" ${m.id===weeklyHistorySelectedId?"selected":""}>${esc(m.label)} · ${esc(m.responsible||"—")} · Rev. ${m.revision||1}${m.needsSync?" · Pendiente respaldo":""}</option>`).join("")}
         </select>
       </label>
       <div class="actions">
         <button class="btn tonal" id="refreshWeeklyHistoryBtn">↻ Actualizar</button>
         <button class="btn tonal" id="printWeeklyHistoryBtn" ${loaded?"":"disabled"}>🖨️ Imprimir</button>
         <button class="btn tonal" id="exportWeeklyHistoryBtn" ${loaded?"":"disabled"}>📥 Exportar CSV</button>
       </div>
     </div>
     ${selected?`<div class="weekly-history-summary">
       <div><small>Semana</small><b>${esc(selected.label||"")}</b></div>
       <div><small>Responsable</small><b>${esc(selected.responsible||"—")}</b></div>
       <div><small>Cerrada</small><b>${esc(new Date(selected.closedAt).toLocaleString("es-GT"))}</b></div>
       <div><small>Productos</small><b>${Number(selected.itemCount||0)}</b></div>
       <div><small>Diferencias</small><b>${Number(selected.differences||0)}</b></div>
       <div><small>Respaldo</small><b>${selected.needsSync?"Pendiente":"Guardado"}</b></div>
     </div>`:""}
     ${loaded?weeklyHistoryTable(loaded):`<div class="empty">${weeklyHistoryLoading?"Cargando semana...":"Cargando detalle de la semana seleccionada..."}</div>`}
   `:`<div class="empty">Todavía no hay semanas cerradas en el historial.</div>`}
 </section>`;
}
function printWeeklyArchive(archive){
 if(!archive?.items?.length)return toast("No hay datos históricos para imprimir.");
 const rows=archive.items.map(item=>`<tr>
   <td>${esc(item.code||"")}</td><td>${esc(item.catalog||"")}</td><td>${esc(item.name||"")}</td>
   <td>${esc(item.family||"")}</td><td>${Number(item.expected||0)}</td>
   <td>${item.physical===""?"":Number(item.physical)}</td>
   <td>${item.confirmed?"✓":""}</td>
   <td>${item.difference===null||item.difference===undefined?"":`${Number(item.difference)>0?"+":""}${Number(item.difference)}`}</td>
   <td>${esc(item.status||"")}</td><td>${esc(item.obs||"")}</td>
 </tr>`).join("");
 const w=window.open("","_blank","width=1100,height=800");
 if(!w)return toast("El navegador bloqueó la ventana de impresión.");
 w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(archive.label)}</title><style>
 @page{size:A4 landscape;margin:9mm}
 body{font-family:Arial,sans-serif;color:#111;margin:0;font-size:10px}
 h1{font-size:18px;margin:0 0 4px}.sub{color:#555;margin-bottom:10px}
 table{width:100%;border-collapse:collapse;table-layout:auto}th,td{border:1px solid #777;padding:5px}th{background:#eee}th:nth-child(1),td:nth-child(1),th:nth-child(2),td:nth-child(2),th:nth-child(3),td:nth-child(3){white-space:nowrap}
 </style></head><body><h1>Historial Conteo Semanal</h1>
 <div class="sub">${esc(archive.label)} · Responsable: ${esc(archive.responsible||"")} · Cerrada: ${esc(new Date(archive.closedAt).toLocaleString("es-GT"))}</div>
 <table><thead><tr><th>Código</th><th>Catálogo</th><th>Descripción</th><th>Familia</th><th>Exist.</th><th>Físico</th><th>✓</th><th>Dif.</th><th>Estado</th><th>Obs.</th></tr></thead><tbody>${rows}</tbody></table>
 <script>window.onload=()=>window.print()<\/script></body></html>`);
 w.document.close();
}
function exportWeeklyArchiveCSV(archive){
 if(!archive?.items?.length)return toast("No hay datos históricos para exportar.");
 const rows=[["Semana","Responsable","Cerrada","Código","Catálogo","Descripción","Familia","Existencia","Físico","Confirmado","Confirmado en","Confirmado por","Diferencia","Estado","Observación"],
 ...(archive.items||[]).map(i=>[
   archive.label,archive.responsible,new Date(archive.closedAt).toLocaleString("es-GT"),
   i.code,i.catalog,i.name,i.family,i.expected,i.physical,i.confirmed?"Sí":"No",i.confirmedAt||"",i.confirmedBy||"",i.difference,i.status,i.obs
 ])];
 download(`historial_${String(archive.label||"semana").replace(/[^\w-]+/g,"_")}.csv`,
   "\ufeff"+rows.map(r=>r.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\n"),
   "text/csv");
}
function weeklyCountState(productId){
 const raw=state.weeklyCounts[productId]||{};
 return {
   physical:raw.physical===0?0:(raw.physical??""),
   obs:raw.obs||"",
   updatedAt:raw.updatedAt||"",
   confirmed:!!raw.confirmed,
   confirmedAt:raw.confirmedAt||"",
   confirmedBy:raw.confirmedBy||"",
   confirmedStock:Number.isFinite(Number(raw.confirmedStock))?Number(raw.confirmedStock):null
 };
}
function weeklyExpectedStock(product){
 const raw=state.weeklyCounts[product?.id]||{};
 if(raw.confirmed&&raw.confirmedStock!==null&&raw.confirmedStock!==undefined&&raw.confirmedStock!==""){
   const n=Number(raw.confirmedStock);
   if(Number.isFinite(n))return n;
 }
 return Number(product?.stock||0);
}
function weeklyDiff(product,physical){
 if(physical===""||physical===null||physical===undefined)return "";
 const n=Number(physical);
 if(Number.isNaN(n))return "";
 return n-weeklyExpectedStock(product);
}
function weeklyStatus(product,physical){
 if(physical===""||physical===null||physical===undefined)return {text:"Pendiente",cls:"pending"};
 const diff=weeklyDiff(product,physical);
 if(diff===0)return {text:"Cuadreado",cls:"count-balanced"};
 if(diff>0)return {text:"Sobrante",cls:"count-surplus"};
 return {text:"Faltante",cls:"count-shortage"};
}
function formatDMY(d){
 return d.toLocaleDateString("es-GT",{day:"2-digit",month:"2-digit",year:"numeric"});
}
function mondaySaturdayRange(baseDate=new Date()){
 const d=new Date(baseDate.getFullYear(),baseDate.getMonth(),baseDate.getDate());
 const day=d.getDay(); // 0 domingo, 1 lunes...
 let monday;
 if(day===0){
   monday=new Date(d);
   monday.setDate(d.getDate()+1); // domingo -> siguiente lunes
 }else{
   monday=new Date(d);
   monday.setDate(d.getDate()-(day-1));
 }
 const saturday=new Date(monday);
 saturday.setDate(monday.getDate()+5);
 return {monday,saturday,label:`SEMANA ${formatDMY(monday)} - ${formatDMY(saturday)}`};
}
function nextMondaySaturdayRange(){
 const current=mondaySaturdayRange(new Date());
 const nextMonday=new Date(current.monday);
 nextMonday.setDate(current.monday.getDate()+7);
 return mondaySaturdayRange(nextMonday);
}
function weeklyExtraProducts(){
 return (state.weeklyMeta.extraProducts||[]).map(p=>({
   ...p,
   weeklyOnly:true,
   stock:Number(p.stock||0),
   min:0,max:0,reorder:0,
   catalog:p.catalog||"",
   name:p.name||"Código no registrado",
   family:p.family||""
 }));
}
function findWeeklyProductByCode(code){
 const q=String(code||"").trim().toLowerCase();
 return state.inventory.find(p=>String(p.code||"").trim().toLowerCase()===q)
   || weeklyExtraProducts().find(p=>String(p.code||"").trim().toLowerCase()===q)
   || null;
}
function addWeeklyOnlyCode(code){
 const clean=String(code||"").trim();
 if(!clean)return null;
 const existing=findWeeklyProductByCode(clean);
 if(existing)return existing;

 const temp={
   id:"weekly-"+uid(),
   code:clean,
   catalog:"",
   name:"Código no registrado",
   family:"",
   stock:0,
   weeklyOnly:true
 };
 if(!Array.isArray(state.weeklyMeta.extraProducts))state.weeklyMeta.extraProducts=[];
 state.weeklyMeta.extraProducts.push(temp);
 return temp;
}

function weeklyFamilies(){
 return [...new Set([...state.inventory,...weeklyExtraProducts()].map(p=>String(p.family||"").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"es"));
}
function weeklySelectedProducts(){
 if(!state.weeklyMeta.active)return [];
 const all=[...state.inventory,...weeklyExtraProducts()];
 const byId=new Map(all.map(p=>[p.id,p]));
 return (state.weeklyMeta.productIds||[])
   .map(id=>byId.get(id))
   .filter(Boolean);
}
function weeklyFilteredProducts(){
 let items=weeklySelectedProducts();
 const fam=String(state.weeklyMeta.filterFamily||"").trim();
 if(fam)items=items.filter(p=>String(p.family||"")===fam);

 const from=state.weeklyMeta.dateFrom?new Date(state.weeklyMeta.dateFrom+"T00:00:00"):null;
 const to=state.weeklyMeta.dateTo?new Date(state.weeklyMeta.dateTo+"T23:59:59"):null;
 if(from||to){
   items=items.filter(p=>{
     const c=weeklyCountState(p.id);
     if(!c.updatedAt)return false;
     const d=parseGTDate(c.updatedAt);
     if(!d)return false;
     if(from&&d<from)return false;
     if(to&&d>to)return false;
     return true;
   });
 }
 return items;
}
function parseGTDate(v){
 if(!v)return null;
 const direct=new Date(v);
 if(!Number.isNaN(direct.getTime()))return direct;
 const m=String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
 if(!m)return null;
 return new Date(+m[3],+m[2]-1,+m[1],+m[4],+m[5],+(m[6]||0));
}
function weeklyCountRows(items=weeklyFilteredProducts()){
 if(!state.weeklyMeta.active)return `<tr><td colspan="10"><div class="empty">Primero crea una semana para comenzar el conteo.</div></td></tr>`;
 if(!items.length)return `<tr><td colspan="10"><div class="empty">La semana está creada, pero todavía no has agregado productos.<br>Importa códigos o usa “Traer productos desde Inventario”.</div></td></tr>`;
 return items.map(p=>{
   const c=weeklyCountState(p.id),diff=weeklyDiff(p,c.physical),st=weeklyStatus(p,c.physical);
   const rowLocked=!!state.weeklyMeta.closed||!!c.confirmed;
   const disabled=rowLocked?"disabled":"";
   const expected=weeklyExpectedStock(p);
   const confirmDisabled=state.weeklyMeta.closed?"disabled":"";
   const confirmTitle=c.confirmed
     ? `Confirmado${c.confirmedBy?` por ${c.confirmedBy}`:""}${c.confirmedAt?` · ${new Date(c.confirmedAt).toLocaleString("es-GT")}`:""}. Desmarca para editar.`
     : "Solo se puede confirmar cuando Físico coincide con Existencia.";
   const hasPhysical=c.physical!==""&&c.physical!==null&&c.physical!==undefined;
   const rowClasses=[c.confirmed?"weekly-row-confirmed":"",hasPhysical?"weekly-row-counted":""].filter(Boolean).join(" ");
   return `<tr class="${rowClasses}" data-weekly-row="${p.id}">
     <td><b>${esc(p.code)}</b></td>
     <td>${p.weeklyOnly?`<input class="weekly-meta-input" data-weekly-extra-field="catalog" data-weekly-extra-id="${p.id}" value="${esc(p.catalog||"")}" placeholder="Catálogo (opcional)" ${disabled}>`:esc(p.catalog||"—")}</td>
     <td>${p.weeklyOnly?`<input class="weekly-meta-input weekly-desc-input" data-weekly-extra-field="name" data-weekly-extra-id="${p.id}" value="${esc(p.name==="Código no registrado"?"":p.name)}" placeholder="Descripción" ${disabled}>`:esc(p.name)}</td>
     <td>${p.weeklyOnly?`<input class="weekly-meta-input" data-weekly-extra-field="family" data-weekly-extra-id="${p.id}" value="${esc(p.family||"")}" placeholder="Familia" ${disabled}>`:esc(p.family||"—")}</td>
     <td class="qty">${p.weeklyOnly?`<input class="weekly-extra-stock no-spinner" data-weekly-extra-field="stock" data-weekly-extra-id="${p.id}" type="number" min="0" inputmode="numeric" value="${expected}" title="Existencia solo para esta semana" ${disabled}>`:expected}</td>
     <td><input class="weekly-physical no-spinner" type="number" inputmode="numeric" min="0" step="1" placeholder="0" value="${c.physical===""?"":esc(c.physical)}" data-weekly-physical="${p.id}" ${disabled}></td>
     <td class="weekly-confirm-cell"><label class="weekly-confirm-box" title="${esc(confirmTitle)}"><input type="checkbox" data-weekly-confirm="${p.id}" ${c.confirmed?"checked":""} ${confirmDisabled}><span aria-hidden="true">✓</span></label></td>
     <td class="qty weekly-diff" data-weekly-diff="${p.id}">${diff===""?"—":(diff>0?"+":"")+diff}</td>
     <td><span class="chip ${st.cls}" data-weekly-status="${p.id}">${st.text}</span></td>
     <td><input class="weekly-obs" type="text" placeholder="Observación..." value="${esc(c.obs)}" data-weekly-obs="${p.id}" ${disabled}></td>
   </tr>`;
 }).join("");
}
function weeklyToolbar(){
 const fams=weeklyFamilies();
 const active=!!state.weeklyMeta.active;
 const closed=!!state.weeklyMeta.closed;
 return `<div class="weekly-toolbar">
   <div class="drop-wrap">
     <button class="toolbar-btn" data-menu-btn="filterMenu">🔎 Filtros <span>⌄</span></button>
     <div class="drop-menu filter-menu" id="filterMenu" hidden>
       <label>Semana
         <select id="weeklyFilterWeek">
           <option value="current">${active?esc(state.weeklyMeta.label):"SIN SEMANA ACTIVA"}</option>
         </select>
       </label>
       <label>Familia
         <select id="weeklyFilterFamily">
           <option value="">TODAS LAS FAMILIAS</option>
           ${fams.map(f=>`<option value="${esc(f)}" ${state.weeklyMeta.filterFamily===f?"selected":""}>${esc(f)}</option>`).join("")}
         </select>
       </label>
       <label>Fecha Desde<input type="date" id="weeklyDateFrom" value="${esc(state.weeklyMeta.dateFrom||"")}"></label>
       <label>Fecha Hasta<input type="date" id="weeklyDateTo" value="${esc(state.weeklyMeta.dateTo||"")}"></label>
       <button class="menu-line" id="clearWeeklyDates">🧹 Limpiar fechas</button>
     </div>
   </div>

   <div class="drop-wrap">
     <button class="toolbar-btn" data-menu-btn="fileMenu" ${active?"":"disabled"}>📁 Archivo <span>⌄</span></button>
     <div class="drop-menu compact-menu" id="fileMenu" hidden>
       <button class="menu-line" id="importCodesBtn" ${active&&!closed?"":"disabled"}>📥 Importar códigos</button>
       <button class="menu-line" id="exportWeeklyCsv" ${active?"":"disabled"}>📥 Exportar CSV</button>
       <button class="menu-line" id="downloadWeeklyTemplate" ${active?"":"disabled"}>📄 Descargar plantilla</button>
     </div>
   </div>

   <div class="drop-wrap">
     <button class="toolbar-btn" data-menu-btn="printMenu" ${active?"":"disabled"}>🖨️ Imprimir <span>⌄</span></button>
     <div class="drop-menu print-menu" id="printMenu" hidden>
       <div class="menu-title"><b>Imprimir conteo</b><small>Selecciona qué deseas llevar a la hoja.</small></div>
       <button class="menu-line rich" data-print-mode="all">📁 <span><b>Semana completa</b><small>Todos los productos agregados a la semana</small></span>›</button>
       <button class="menu-line rich" data-print-mode="filtered">🔎 <span><b>Vista filtrada</b><small>Usa familia y fechas actuales</small></span>›</button>
       <button class="menu-line rich" data-print-mode="family" ${state.weeklyMeta.filterFamily?"":"disabled"}>📦 <span><b>Familia seleccionada</b><small>${state.weeklyMeta.filterFamily?esc(state.weeklyMeta.filterFamily):"Selecciona una familia en Filtros"}</small></span>›</button>
       <button class="menu-line rich" data-print-mode="pending">⌛ <span><b>Solo pendientes</b><small>Productos sin cantidad física ingresada</small></span>›</button>
       <button class="menu-line rich" data-print-mode="diffs">⚠️ <span><b>Solo diferencias</b><small>Productos con faltante o sobrante</small></span>›</button>
     </div>
   </div>

   <div class="drop-wrap">
     <button class="toolbar-btn" data-menu-btn="actionsMenu">⚡ Acciones <span>⌄</span></button>
     <div class="drop-menu action-menu" id="actionsMenu" hidden>
       <button class="menu-line primary-line" id="createWeekBtn" ${active?"disabled":""}>＋ Crear semana</button>
       <button class="menu-line" id="nextWeekBtn" ${active&&closed?"":"disabled"}>🗓️ Crear siguiente semana</button>
       <button class="menu-line" id="pullInventoryBtn" ${active&&!closed?"":"disabled"}>📦 Traer productos desde Inventario</button>
       <button class="menu-line" id="addWeeklyCodeBtn" ${active&&!closed?"":"disabled"}>✚ Agregar código</button>
       <button class="menu-line" id="resetPhysicalBtn" ${active&&!closed?"":"disabled"}>↻ Reiniciar conteo físico</button>
       <button class="menu-line" id="saveSheetsBtn" ${active?"":"disabled"}>💾 Guardar en Google Sheets</button>
       <button class="menu-line primary-line" id="closeWeekBtn" ${active&&!closed?"":"disabled"}>🔒 Cerrar semana</button>
       <button class="menu-line" id="reopenWeekBtn" ${active&&closed?"":"disabled"}>🔓 Reabrir semana</button>
     </div>
   </div>
 </div>
 <input type="file" id="weeklyImportFile" accept=".csv,text/csv" hidden>`;
}
function renderConteo(){
 if(weeklyView==="history")return renderWeeklyHistory();

 const items=weeklyFilteredProducts();
 const completed=items.filter(p=>weeklyCountState(p.id).physical!=="").length;
 const diffs=items.filter(p=>{const c=weeklyCountState(p.id);return c.physical!==""&&weeklyDiff(p,c.physical)!==0}).length;

 const summary=state.weeklyMeta.active
   ? `${esc(state.weeklyMeta.label)} · Responsable: ${esc(state.weeklyMeta.responsible||"—")} · ${completed} de ${items.length} contados · ${diffs} con diferencia${state.weeklyMeta.orderSource==="template"?" · Orden: plantilla":""} ${state.weeklyMeta.closed?"· 🔒 Cerrada":""}`
   : `Sin semana activa · Crea una semana para comenzar`;

 return `<section class="panel weekly-panel">
   <div class="panel-head weekly-head">
     <div><h2>Conteo Semanal</h2><p>${summary}</p></div>
     <div class="weekly-head-actions">
       ${weeklyHistoryTabs()}
       ${weeklyToolbar()}
     </div>
   </div>
   <div class="table-wrap"><table class="weekly-table">
     <thead><tr>
       <th>Código</th><th>Catálogo</th><th>Descripción</th><th>Familia</th><th>Exist.</th>
       <th>Físico (editable)</th><th class="weekly-confirm-head">✓ Confirmar</th><th>Dif.</th><th>Estado</th><th>Obs. (editable)</th>
     </tr></thead>
     <tbody>${weeklyCountRows(items)}</tbody>
   </table></div>
 </section>`;
}
function digitalArchiveChecksum(items){
 return weeklyArchiveHash(JSON.stringify((items||[]).map(i=>[
   i.productId||"",i.code||"",catalogText(i.catalog),i.name||"",i.family||"",
   Number(i.expected||0),i.physical===""?"":Number(i.physical),
   i.difference===""||i.difference===null||i.difference===undefined?"":Number(i.difference),
   i.status||"",i.obs||"",i.countedAt||""
 ])));
}
function digitalArchiveMeta(archive,needsSync=false){
 if(!archive)return null;
 const items=Array.isArray(archive.items)?archive.items:[];
 const counted=Number(archive.counted??items.length??0)||0;
 const differences=Number(archive.differences??items.filter(i=>Number(i.difference||0)!==0).length)||0;
 return {
   id:String(archive.id||""),
   sessionId:String(archive.sessionId||archive.id||""),
   family:String(archive.family||"Sin familia"),
   responsible:String(archive.responsible||"—"),
   archivedAt:String(archive.archivedAt||archive.updatedAt||""),
   updatedAt:String(archive.updatedAt||archive.archivedAt||""),
   reason:String(archive.reason||"Historial"),
   inventoryVersionAt:String(archive.inventoryVersionAt||""),
   totalProducts:Number(archive.totalProducts||0),
   counted,
   balanced:Number(archive.balanced??Math.max(0,counted-differences))||0,
   shortages:Number(archive.shortages??items.filter(i=>Number(i.difference||0)<0).length)||0,
   surpluses:Number(archive.surpluses??items.filter(i=>Number(i.difference||0)>0).length)||0,
   differences,
   itemCount:Number(archive.itemCount||items.length||counted)||0,
   checksum:String(archive.checksum||digitalArchiveChecksum(items)),
   needsSync:!!needsSync,
   lastSyncedAt:String(archive.lastSyncedAt||""),
   syncError:String(archive.syncError||"")
 };
}
function migrateLegacyDigitalHistoryStorage(){
 if(!Array.isArray(state.digitalHistory))state.digitalHistory=[];
 if(!Array.isArray(state.digitalArchiveQueue))state.digitalArchiveQueue=[];
 const queueById=new Map(state.digitalArchiveQueue.filter(a=>a&&a.id).map(a=>[String(a.id),a]));
 const metaById=new Map();
 state.digitalHistory.filter(Boolean).forEach(old=>{
   if(!old.id)return;
   if(Array.isArray(old.items)&&old.items.length){
     const archive={...old,sessionId:old.sessionId||old.id,itemCount:Number(old.itemCount||old.items.length),checksum:old.checksum||digitalArchiveChecksum(old.items)};
     if(!queueById.has(String(archive.id)))queueById.set(String(archive.id),archive);
     metaById.set(String(archive.id),digitalArchiveMeta(archive,true));
   }else{
     metaById.set(String(old.id),digitalArchiveMeta(old,old.needsSync===true));
   }
 });
 state.digitalArchiveQueue=[...queueById.values()];
 state.digitalHistory=[...metaById.values()].sort((a,b)=>digitalHistoryTimeMs(b)-digitalHistoryTimeMs(a));
}
function digitalHistoryMetaById(id){
 return (state.digitalHistory||[]).find(a=>String(a.id||"")===String(id||""))||null;
}
function digitalArchiveQueuedById(id){
 return (state.digitalArchiveQueue||[]).find(a=>String(a.id||"")===String(id||""))||null;
}
function mergeDigitalHistoryMeta(remote){
 if(!Array.isArray(state.digitalHistory))state.digitalHistory=[];
 const map=new Map(state.digitalHistory.filter(Boolean).map(a=>[String(a.id||""),a]));
 (Array.isArray(remote)?remote:[]).forEach(raw=>{
   if(!raw?.id)return;
   const incoming=digitalArchiveMeta(raw,false);
   const local=map.get(String(incoming.id));
   if(!local||local.needsSync!==true||digitalHistoryTimeMs(incoming)>=digitalHistoryTimeMs(local))map.set(String(incoming.id),{...local,...incoming,needsSync:false});
 });
 state.digitalHistory=[...map.values()].sort((a,b)=>digitalHistoryTimeMs(b)-digitalHistoryTimeMs(a));
}
function digitalHistoryTimeMs(a){
 const d=new Date(a?.archivedAt||a?.updatedAt||0);
 return Number.isNaN(d.getTime())?0:d.getTime();
}
function mergeDigitalHistoryRemote(remote){
 const legacyFull=(Array.isArray(remote)?remote:[]).filter(a=>a&&a.id&&Array.isArray(a.items)&&a.items.length);
 legacyFull.forEach(a=>{
   const archive={...a,sessionId:a.sessionId||a.id,itemCount:Number(a.itemCount||a.items.length),checksum:a.checksum||digitalArchiveChecksum(a.items)};
   if(!digitalArchiveQueuedById(archive.id))state.digitalArchiveQueue.push(archive);
   digitalHistoryCache.set(String(archive.id),archive);
 });
 mergeDigitalHistoryMeta(remote);
 legacyFull.forEach(a=>{const m=digitalHistoryMetaById(a.id);if(m)m.needsSync=true;});
 normalizeCatalogFields();
}
function buildDigitalArchiveItems(family){
 const fam=String(family||"").trim();
 return orderedProducts(state.inventory.filter(p=>String(p.family||"").trim()===fam)).map(p=>{
   const c=state.digitalCounts[p.id];
   if(!c||c.physical===""||c.physical===null||c.physical===undefined)return null;
   const physical=Number(c.physical);
   const expected=(c.expectedAtCount!==""&&c.expectedAtCount!==null&&c.expectedAtCount!==undefined&&Number.isFinite(Number(c.expectedAtCount)))
     ? Number(c.expectedAtCount)
     : Number(p.stock||0);
   const difference=physical-expected;
   return {
     productId:p.id,
     code:p.code||"",
     catalog:catalogText(p.catalog),
     name:p.name||"",
     family:p.family||fam,
     expected,
     physical,
     difference,
     status:difference===0?"Cuadreado":difference>0?"Sobrante":"Faltante",
     obs:c.obs||"",
     countedAt:c.updatedAt||c.countedAt||new Date().toISOString()
   };
 }).filter(Boolean);
}
function archiveDigitalFamily(family,reason="Cierre de familia",responsibleOverride=""){
 const fam=String(family||"").trim();
 if(!fam)return null;
 const items=buildDigitalArchiveItems(fam);
 if(!items.length)return null;
 if(!Array.isArray(state.digitalHistory))state.digitalHistory=[];
 if(!Array.isArray(state.digitalArchiveQueue))state.digitalArchiveQueue=[];
 const familyTotal=state.inventory.filter(p=>String(p.family||"").trim()===fam).length;
 const responsible=String(responsibleOverride||items.map(i=>state.digitalCounts[i.productId]?.responsible).find(Boolean)||state.digitalFilter.responsible||"—").trim()||"—";
 const now=new Date().toISOString();
 const sessionId=uid();
 const archive={
   id:sessionId,sessionId,family:fam,responsible,archivedAt:now,updatedAt:now,reason:String(reason||"Historial"),
   inventoryVersionAt:state.inventoryVersionAt||"",totalProducts:familyTotal,counted:items.length,
   balanced:items.filter(i=>i.difference===0).length,
   shortages:items.filter(i=>i.difference<0).length,
   surpluses:items.filter(i=>i.difference>0).length,
   differences:items.filter(i=>i.difference!==0).length,
   itemCount:items.length,
   checksum:digitalArchiveChecksum(items),
   items
 };
 state.digitalHistory.push(digitalArchiveMeta(archive,true));
 state.digitalArchiveQueue.push(archive);
 digitalHistoryCache.set(archive.id,archive);
 state.digitalHistory.sort((a,b)=>digitalHistoryTimeMs(b)-digitalHistoryTimeMs(a));
 if(!authState.localOnly&&cloudConfig.enabled&&cloudReady())setTimeout(()=>syncDigitalArchiveQueue(false),250);
 return archive;
}
function hasEquivalentDigitalArchive(family,items){
 const fam=String(family||"").trim();
 const checksum=digitalArchiveChecksum(items||[]);
 const count=(items||[]).length;
 return (state.digitalHistory||[]).some(m=>
   String(m?.family||"").trim()===fam&&
   String(m?.inventoryVersionAt||"")===String(state.inventoryVersionAt||"")&&
   Number(m?.itemCount||0)===count&&
   String(m?.checksum||"")===checksum
 );
}
function archiveAllCurrentDigitalCounts(reason="Importación de inventario",dedupeExisting=false){
 const families=new Set();
 state.inventory.forEach(p=>{
   const c=state.digitalCounts[p.id];
   if(c&&c.physical!==""&&c.physical!==null&&c.physical!==undefined)families.add(String(p.family||"Sin familia").trim()||"Sin familia");
 });
 let created=0,alreadyProtected=0;
 families.forEach(f=>{
   if(dedupeExisting){
     const items=buildDigitalArchiveItems(f);
     if(items.length&&hasEquivalentDigitalArchive(f,items)){alreadyProtected++;return;}
   }
   if(archiveDigitalFamily(f,reason))created++;
 });
 return {created,alreadyProtected,total:families.size};
}
function pendingDigitalArchiveCount(){return (state.digitalArchiveQueue||[]).length;}
async function verifyDigitalArchiveSaved(archive){
 const r=await cloudJsonp("digital_history_status",{id:archive.id});
 return !!(r?.ok&&r?.saved&&String(r.id||"")===String(archive.id)&&Number(r.itemCount||0)===Number(archive.itemCount||archive.items?.length||0)&&String(r.checksum||"")===String(archive.checksum||""));
}
async function saveDigitalArchiveToSheets(archive){
 if(!archive?.id)throw new Error("Historial digital vacío.");
 if(!cloudConfig.enabled||!cloudReady())throw new Error("Google Sheets no está conectado.");
 const payload={action:"save_digital_archive",token:cloudConfig.proxy?"":cloudConfig.token,archive};
 const opts={method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify(payload)};
 if(cloudConfig.proxy)opts.credentials="same-origin";
 else opts.mode="no-cors";
 const res=await fetch(normalizeCloudUrl(cloudConfig.url),opts);
 if(cloudConfig.proxy){
   let data={};try{data=await res.json()}catch{}
   if(!res.ok||!data?.ok)throw new Error(data?.error||"No se pudo guardar el Historial de Inventario Digital.");
 }
 let confirmed=false;
 for(let attempt=0;attempt<4&&!confirmed;attempt++){
   await new Promise(r=>setTimeout(r,650+attempt*450));
   try{confirmed=await verifyDigitalArchiveSaved(archive)}catch{}
 }
 if(!confirmed)throw new Error("Google Sheets no confirmó el Historial de Inventario Digital.");
 return true;
}
async function syncDigitalArchiveQueue(blocking=false){
 if(!state.digitalArchiveQueue?.length)return true;
 if(authState.localOnly||!cloudConfig.enabled||!cloudReady())return false;
 const queue=[...state.digitalArchiveQueue];
 for(const archive of queue){
   try{
     await saveDigitalArchiveToSheets(archive);
     state.digitalArchiveQueue=state.digitalArchiveQueue.filter(a=>String(a.id)!==String(archive.id));
     const meta=digitalHistoryMetaById(archive.id);
     if(meta){meta.needsSync=false;meta.lastSyncedAt=new Date().toISOString();meta.syncError="";}
     digitalHistoryCache.set(archive.id,archive);
     saveLocal();
   }catch(err){
     const meta=digitalHistoryMetaById(archive.id);
     if(meta){meta.needsSync=true;meta.syncError=String(err?.message||"Error de respaldo");}
     saveLocal();
     if(blocking)return false;
   }
 }
 return state.digitalArchiveQueue.length===0;
}
async function recoverDigitalHistoryList(silent=true){
 try{
   if(!cloudConfig.enabled||!cloudReady())return false;
   const r=await cloudJsonp("digital_history_list");
   if(!r?.ok)throw new Error(r?.error||"No se pudo leer el historial de Inventario Digital.");
   const list=Array.isArray(r.archives)?r.archives:[];
   mergeDigitalHistoryMeta(list);
   saveLocal();
   if(!silent)toast(`Historial digital: ${list.length} conteo(s).`);
   return true;
 }catch(err){
   console.error(err);
   if(!silent)toast(err?.message||"No se pudo recuperar el historial de Inventario Digital.");
   return false;
 }
}
async function loadDigitalArchive(id,silent=true){
 const clean=String(id||"");if(!clean)return null;
 if(digitalHistoryCache.has(clean))return digitalHistoryCache.get(clean);
 const queued=digitalArchiveQueuedById(clean);
 if(queued){digitalHistoryCache.set(clean,queued);return queued;}
 if(!cloudConfig.enabled||!cloudReady()){
   if(!silent)toast("Conéctate a Google Sheets para abrir el detalle histórico.");
   return null;
 }
 try{
   digitalHistoryLoadingId=clean;
   const r=await cloudJsonp("digital_history",{id:clean});
   if(!r?.ok||!r.archive)throw new Error(r?.error||"No se pudo cargar el conteo archivado.");
   const archive=r.archive;
   if(Array.isArray(archive.items))archive.items.forEach(i=>{i.catalog=catalogText(i.catalog);});
   digitalHistoryCache.set(clean,archive);
   return archive;
 }catch(err){
   console.error(err);
   if(!silent)toast(err?.message||"No se pudo cargar el historial.");
   return null;
 }finally{digitalHistoryLoadingId="";}
}
async function ensureDigitalArchiveLoaded(id,silent=true){
 const clean=String(id||"");if(!clean)return null;
 const archive=await loadDigitalArchive(clean,silent);
 if(archive&&String(digitalHistorySelectedId)===clean){digitalHistoryLoadedArchive=archive;render();}
 return archive;
}
function digitalHistoryRowsSorted(){
 return [...(state.digitalHistory||[])].sort((a,b)=>digitalHistoryTimeMs(b)-digitalHistoryTimeMs(a));
}
function digitalHistoryLatestByFamily(){
 const map=new Map();
 digitalHistoryRowsSorted().forEach(a=>{const f=String(a.family||"Sin familia");if(!map.has(f))map.set(f,a);});
 return [...map.values()];
}
function digitalHistoryDate(iso){
 const d=new Date(iso||0);if(Number.isNaN(d.getTime()))return "—";
 return d.toLocaleString("es-GT",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
}
function digitalHistoryTabs(){
 return `<div class="digital-view-tabs">
   <button class="btn ${digitalView==="current"?"primary":"tonal"}" data-digital-view="current">Conteo actual</button>
   <button class="btn ${digitalView==="history"?"primary":"tonal"}" data-digital-view="history">Historial (${(state.digitalHistory||[]).length})</button>
 </div>`;
}
function digitalHistoryDetailFor(id){
 const clean=String(id||"");
 if(!clean)return null;
 return digitalHistoryCache.get(clean)||digitalArchiveQueuedById(clean)||((digitalHistoryLoadedArchive&&String(digitalHistoryLoadedArchive.id)===clean)?digitalHistoryLoadedArchive:null);
}
function renderDigitalHistory(){
 const archives=digitalHistoryRowsSorted();
 if(!digitalHistorySelectedId&&archives.length)digitalHistorySelectedId=archives[0].id;
 const selected=archives.find(a=>a.id===digitalHistorySelectedId)||archives[0]||null;
 if(selected)digitalHistorySelectedId=selected.id;
 const detail=selected?digitalHistoryDetailFor(selected.id):null;
 if(selected&&!detail&&digitalHistoryLoadingId!==String(selected.id))setTimeout(()=>ensureDigitalArchiveLoaded(selected.id,true),0);
 const optionsHtml=archives.map(a=>`<option value="${esc(a.id)}" ${selected&&a.id===selected.id?"selected":""}>${esc(a.family)} · ${esc(a.responsible||"—")} · ${esc(digitalHistoryDate(a.archivedAt))} · ${esc(a.reason||"")}</option>`).join("");
 const rows=detail?(detail.items||[]).map(i=>`<tr>
   <td><b>${esc(i.code||"—")}</b></td><td>${esc(i.catalog||"—")}</td><td>${esc(i.name||"—")}</td><td>${esc(i.family||"—")}</td>
   <td class="qty">${Number(i.expected||0)}</td><td class="qty">${Number(i.physical||0)}</td>
   <td class="qty">${Number(i.difference)>0?"+":""}${Number(i.difference||0)}</td>
   <td><span class="chip ${Number(i.difference)===0?"count-balanced":Number(i.difference)>0?"count-surplus":"count-shortage"}">${esc(i.status||"—")}</span></td>
   <td>${esc(i.obs||"—")}</td></tr>`).join(""):"";
 const syncLabel=selected?.needsSync?`<span class="chip pending">Respaldo pendiente</span>`:`<span class="chip count-balanced">Guardado en Sheets</span>`;
 return `<section class="panel digital-panel digital-history-panel">
   <div class="panel-head digital-history-head"><div><h2>Historial · Inventario Digital</h2><p>Cada cierre es una sesión independiente. El detalle permanente se guarda en Google Sheets y no cambia con nuevas importaciones.</p></div>${digitalHistoryTabs()}</div>
   ${archives.length?`<div class="digital-history-toolbar"><label>Conteo archivado<select id="digitalHistorySelect">${optionsHtml}</select></label><button class="btn tonal" id="printDigitalHistoryBtn">🖨️ Imprimir historial</button></div>
   <div class="digital-history-summary">
     <div><small>Familia</small><b>${esc(selected.family||"—")}</b></div><div><small>Responsable</small><b>${esc(selected.responsible||"—")}</b></div>
     <div><small>Archivado</small><b>${esc(digitalHistoryDate(selected.archivedAt))}</b></div><div><small>Motivo</small><b>${esc(selected.reason||"—")}</b></div>
     <div><small>Contados</small><b>${Number(selected.counted||0)} / ${Number(selected.totalProducts||0)}</b></div><div><small>Diferencias</small><b>${Number(selected.differences||0)}</b></div>
   </div><div class="digital-history-syncline">${syncLabel}</div>
   ${detail?`<div class="table-wrap"><table class="digital-history-table"><thead><tr><th>Código</th><th>Catálogo</th><th>Descripción</th><th>Familia</th><th>Exist. al contar</th><th>Físico</th><th>Dif.</th><th>Estado</th><th>Obs.</th></tr></thead><tbody>${rows}</tbody></table></div>`:`<div class="empty">${digitalHistoryLoadingId===String(selected.id)?"Cargando detalle desde Google Sheets...":"El detalle está guardado en Google Sheets. Conéctate para consultarlo."}</div>`}`:
   `<div class="empty">Todavía no hay conteos archivados. Al cerrar una familia o importar un inventario nuevo, el conteo anterior quedará guardado aquí.</div>`}
 </section>`;
}
async function printDigitalHistoryArchive(archiveOrMeta){
 let archive=archiveOrMeta||null;
 if(archive&&!Array.isArray(archive.items))archive=await loadDigitalArchive(archive.id,false);
 if(!archive||!(archive.items||[]).length)return toast("No hay historial para imprimir.");
 const rows=archive.items.map(i=>`<tr><td>${esc(i.code||"")}</td><td>${esc(i.catalog||"")}</td><td>${esc(i.name||"")}</td><td>${esc(i.family||"")}</td><td>${Number(i.expected||0)}</td><td>${Number(i.physical||0)}</td><td>${Number(i.difference)>0?"+":""}${Number(i.difference||0)}</td><td>${esc(i.status||"")}</td><td>${esc(i.obs||"")}</td></tr>`).join("");
 const w=window.open("","_blank","width=1100,height=800");if(!w)return toast("El navegador bloqueó la impresión.");
 w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Historial Inventario Digital</title><style>body{font-family:Arial,sans-serif;padding:24px;color:#111}h1{margin:0 0 5px}.meta{margin-bottom:18px;color:#555}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #bbb;padding:6px;text-align:left}th{background:#eee}</style></head><body><h1>Inventario Digital · ${esc(archive.family)}</h1><div class="meta">Responsable: ${esc(archive.responsible||"—")} · Archivado: ${esc(digitalHistoryDate(archive.archivedAt))} · ${esc(archive.reason||"")}</div><table><thead><tr><th>Código</th><th>Catálogo</th><th>Descripción</th><th>Familia</th><th>Exist.</th><th>Físico</th><th>Dif.</th><th>Estado</th><th>Obs.</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>setTimeout(()=>window.print(),120)<\/script></body></html>`);w.document.close();
}
function digitalFamiliesOverviewRows(){
 const archives=digitalHistoryLatestByFamily();
 const currentMap=new Map();
 digitalCountedFamilies().forEach(f=>{
   const products=state.inventory.filter(p=>String(p.family||"Sin familia")===f);
   const countedItems=products.filter(p=>{const c=state.digitalCounts[p.id];return c&&c.physical!==""&&c.physical!==null&&c.physical!==undefined});
   if(!countedItems.length)return;
   const differences=countedItems.filter(p=>{const c=state.digitalCounts[p.id];return digitalDiff(p,c.physical)!==0}).length;
   const responsible=countedItems.map(p=>state.digitalCounts[p.id]?.responsible).find(Boolean)||digitalFamilySession(f)?.responsible||"—";
   const lastTimes=countedItems.map(p=>Date.parse(state.digitalCounts[p.id]?.updatedAt||state.digitalCounts[p.id]?.detectedAt||"")||0);
   currentMap.set(f,{
     id:"current:"+f,
     family:f,
     responsible,
     counted:countedItems.length,
     totalProducts:products.length,
     differences,
     balanced:Math.max(0,countedItems.length-differences),
     archivedAt:"",
     current:true,
     closed:digitalFamilyClosed(f),
     lastAt:Math.max(0,...lastTimes)
   });
 });
 const rows=[];
 currentMap.forEach(v=>rows.push(v));
 archives.forEach(a=>{
   const f=String(a.family||"Sin familia");
   if(currentMap.has(f))return;
   rows.push({
     ...a,
     current:false,
     closed:digitalFamilyClosed(f),
     balanced:Math.max(0,Number(a.counted||0)-Number(a.differences||0)),
     lastAt:digitalHistoryTimeMs(a)
   });
 });
 return rows.sort((a,b)=>(Number(b.lastAt)||0)-(Number(a.lastAt)||0)||String(a.family||"").localeCompare(String(b.family||""),"es"));
}
function digitalFamiliesPageTabs(){
 return `<div class="families-page-tabs">
   <button class="btn ${digitalFamiliesPageView==="families"?"primary":"tonal"}" data-families-page-view="families">Familias contabilizadas</button>
   <button class="btn ${digitalFamiliesPageView==="history"?"primary":"tonal"}" data-families-page-view="history">Historial (${(state.digitalHistory||[]).length})</button>
 </div>`;
}
function renderFamiliesCounted(){
 if(digitalFamiliesPageView==="history")return renderFamiliesHistoryPage();
 const rows=digitalFamiliesOverviewRows();
 const total=rows.length;
 const inProgress=rows.filter(r=>r.current&&!r.closed).length;
 const withDiff=rows.filter(r=>Number(r.differences||0)>0).length;
 const balanced=rows.filter(r=>!r.current&&Number(r.differences||0)===0).length;
 const body=rows.map(r=>{
   const isArchive=!r.current;
   const status=r.current?(r.closed?"Cerrada":"En proceso"):(Number(r.differences||0)>0?"Con diferencias":"Cuadreada");
   const chip=r.current?(r.closed?"count-balanced":"pending"):(Number(r.differences||0)>0?"low":"count-balanced");
   const date=r.current?(r.lastAt?digitalHistoryDate(new Date(r.lastAt).toISOString()):"Conteo actual"):digitalHistoryDate(r.archivedAt);
   return `<tr>
     <td class="family-center"><b>${esc(r.family||"Sin familia")}</b></td>
     <td>${esc(r.responsible||"—")}</td>
     <td class="qty">${Number(r.counted||0)} / ${Number(r.totalProducts||0)}</td>
     <td class="qty">${Number(r.balanced||0)}</td>
     <td class="qty">${Number(r.differences||0)}</td>
     <td>${esc(date)}</td>
     <td><span class="chip ${chip}">${status}</span></td>
     <td><div class="table-actions families-actions">
       ${isArchive?`<button class="mini-action" data-family-history="${esc(r.id)}" title="Ver detalle">◉</button><button class="mini-action" data-print-family-history="${esc(r.id)}" title="Imprimir">🖨</button>`:`<button class="mini-action" data-open-counted-family="${esc(r.family)}" data-responsible="${esc(r.responsible||"")}" title="Continuar conteo">↗</button>`}
       ${Number(r.differences||0)>0?`<button class="mini-action" data-go="diferencias" title="Ver diferencias">≠</button>`:""}
       ${isArchive?`<button class="mini-action" data-new-counted-family="${esc(r.family)}" data-archive-id="${esc(r.id)}" data-responsible="${esc(r.responsible||"")}" title="Nuevo conteo con existencias actuales">＋</button>`:""}
     </div></td>
   </tr>`;
 }).join("");
 return `<section class="panel counted-families-page">
   <div class="panel-head counted-families-head"><div><h2>Familias Contadas</h2><p>Resumen del Inventario Digital. Aquí quedan las familias contabilizadas sin ocupar espacio en Inicio.</p></div>${digitalFamiliesPageTabs()}</div>
   <div class="counted-family-summary">
     <div><small>Familias registradas</small><b>${total}</b></div>
     <div><small>En proceso</small><b>${inProgress}</b></div>
     <div><small>Cuadradas</small><b>${balanced}</b></div>
     <div><small>Con diferencias</small><b>${withDiff}</b></div>
   </div>
   ${rows.length?`<div class="table-wrap"><table class="counted-families-table"><thead><tr><th>Familia</th><th>Responsable</th><th>Contados</th><th>Cuadrados</th><th>Diferencias</th><th>Último conteo</th><th>Estado</th><th>Acc.</th></tr></thead><tbody>${body}</tbody></table></div>`:`<div class="empty">Todavía no hay familias contabilizadas. Cuando cierres una familia en Inventario Digital aparecerá aquí.</div>`}
 </section>`;
}
function renderFamiliesHistoryPage(){
 const archives=digitalHistoryRowsSorted();
 if(!digitalHistorySelectedId&&archives.length)digitalHistorySelectedId=archives[0].id;
 const selected=archives.find(a=>a.id===digitalHistorySelectedId)||archives[0]||null;
 if(selected)digitalHistorySelectedId=selected.id;
 const detail=selected?digitalHistoryDetailFor(selected.id):null;
 if(selected&&!detail&&digitalHistoryLoadingId!==String(selected.id))setTimeout(()=>ensureDigitalArchiveLoaded(selected.id,true),0);
 const optionsHtml=archives.map(a=>`<option value="${esc(a.id)}" ${selected&&a.id===selected.id?"selected":""}>${esc(a.family)} · ${esc(a.responsible||"—")} · ${esc(digitalHistoryDate(a.archivedAt))}</option>`).join("");
 const rows=detail?(detail.items||[]).map(i=>`<tr><td><b>${esc(i.code||"—")}</b></td><td>${esc(i.catalog||"—")}</td><td>${esc(i.name||"—")}</td><td class="family-center">${esc(i.family||"—")}</td><td class="qty">${Number(i.expected||0)}</td><td class="qty">${Number(i.physical||0)}</td><td class="qty">${Number(i.difference)>0?"+":""}${Number(i.difference||0)}</td><td><span class="chip ${Number(i.difference)===0?"count-balanced":Number(i.difference)>0?"count-surplus":"count-shortage"}">${esc(i.status||"—")}</span></td><td>${esc(i.obs||"—")}</td></tr>`).join(""):"";
 return `<section class="panel counted-families-page digital-history-panel">
   <div class="panel-head counted-families-head"><div><h2>Historial · Inventario Digital</h2><p>Historial permanente por sesión. Importar un inventario nuevo no modifica los conteos anteriores.</p></div>${digitalFamiliesPageTabs()}</div>
   ${archives.length?`<div class="digital-history-toolbar"><label>Conteo archivado<select id="familiesHistorySelect">${optionsHtml}</select></label><button class="btn tonal" id="familiesPrintHistoryBtn">🖨️ Imprimir historial</button></div>
   <div class="digital-history-summary"><div><small>Familia</small><b>${esc(selected.family||"—")}</b></div><div><small>Responsable</small><b>${esc(selected.responsible||"—")}</b></div><div><small>Archivado</small><b>${esc(digitalHistoryDate(selected.archivedAt))}</b></div><div><small>Motivo</small><b>${esc(selected.reason||"—")}</b></div><div><small>Contados</small><b>${Number(selected.counted||0)} / ${Number(selected.totalProducts||0)}</b></div><div><small>Diferencias</small><b>${Number(selected.differences||0)}</b></div></div>
   ${detail?`<div class="table-wrap"><table class="digital-history-table"><thead><tr><th>Código</th><th>Catálogo</th><th>Descripción</th><th>Familia</th><th>Exist. al contar</th><th>Físico</th><th>Dif.</th><th>Estado</th><th>Obs.</th></tr></thead><tbody>${rows}</tbody></table></div>`:`<div class="empty">${digitalHistoryLoadingId===String(selected.id)?"Cargando detalle desde Google Sheets...":"El detalle está guardado en Google Sheets. Conéctate para consultarlo."}</div>`}`:`<div class="empty">Todavía no hay conteos archivados.</div>`}
 </section>`;
}
function digitalCountedFamilies(){
 const families=new Set();
 state.inventory.forEach(p=>{
   const c=digitalCountState(p.id);
   if(c.physical!==""&&c.physical!==null&&c.physical!==undefined){
     families.add(String(p.family||"Sin familia"));
   }
 });
 return [...families].sort((a,b)=>a.localeCompare(b,"es"));
}
function differenceRecordOpen(rec){
 return !!rec && String(rec.status||"open")==="open";
}
function openDifferenceForProduct(product){
 const code=normalizeImportCode(product?.code);
 return (state.differenceHistory||[]).find(r=>
   differenceRecordOpen(r) &&
   (
     (product?.id&&r.productId===product.id) ||
     (code&&normalizeImportCode(r.code)===code)
   )
 )||null;
}
function resolveDifferenceRecord(rec,resolution="Resuelta"){
 if(!rec||!differenceRecordOpen(rec))return;
 rec.status="resolved";
 rec.resolvedAt=new Date().toISOString();
 rec.resolution=resolution;
 rec.lastCheckedAt=rec.resolvedAt;
 markDifferenceDirty(rec);
}
function syncDifferenceHistoryFromDigital(product){
 if(!product)return null;
 const c=state.digitalCounts[product.id];
 if(!c)return null;

 const physical=c.physical;
 if(physical===""||physical===null||physical===undefined)return null;

 const expected=Number(product.stock||0);
 const physicalNum=Number(physical);
 const diff=physicalNum-expected;
 const now=new Date().toISOString();

 let rec=null;
 if(c.historyId){
   rec=(state.differenceHistory||[]).find(r=>r.id===c.historyId)||null;
   // Si la diferencia anterior ya fue resuelta, una nueva diferencia debe crear
   // un registro nuevo con su propia fecha/hora, no reutilizar el historial cerrado.
   if(rec&&!differenceRecordOpen(rec))rec=null;
 }
 if(!rec)rec=openDifferenceForProduct(product);

 if(diff!==0){
   if(!rec){
     rec={
       id:uid(),
       detectedAt:c.detectedAt||now,
       productId:product.id,
       code:product.code||"",
       catalog:product.catalog||"",
       name:product.name||"",
       family:product.family||"",
       expected,
       physical:physicalNum,
       difference:diff,
       responsible:c.responsible||state.digitalFilter.responsible||"",
       obs:c.obs||"",
       status:"open",
       resolvedAt:"",
       resolution:"",
       lastCheckedAt:c.detectedAt||now,
       lastExpected:expected,
       lastPhysical:physicalNum,
       lastDifference:diff,
       needsSync:true,
       syncError:""
     };
     state.differenceHistory.push(rec);
     c.historyId=rec.id;
     markDifferenceDirty(rec);
     return rec;
   }

   const newObs=c.obs||"";
   const newResponsible=c.responsible||state.digitalFilter.responsible||rec.responsible||"";
   // V70: el registro pendiente debe mostrar SIEMPRE el último físico escrito.
   // Antes solo se actualizaban lastPhysical/lastDifference; por eso, al escribir 42,
   // Diferencias podía conservar el primer dígito (4).
   const detectedExpected=Number.isFinite(Number(rec.expected))?Number(rec.expected):expected;
   const visibleDifference=physicalNum-detectedExpected;
   const changed=
     Number(rec.physical)!==physicalNum ||
     Number(rec.difference)!==visibleDifference ||
     Number(rec.lastExpected)!==expected ||
     Number(rec.lastPhysical)!==physicalNum ||
     Number(rec.lastDifference)!==diff ||
     String(rec.obs||"")!==String(newObs||"") ||
     String(rec.responsible||"")!==String(newResponsible||"");

   c.historyId=rec.id;
   if(changed){
     rec.physical=physicalNum;
     rec.difference=visibleDifference;
     rec.lastCheckedAt=now;
     rec.lastExpected=expected;
     rec.lastPhysical=physicalNum;
     rec.lastDifference=diff;
     rec.obs=newObs;
     rec.responsible=newResponsible;
     markDifferenceDirty(rec);
   }
   return rec;
 }

 if(rec&&differenceRecordOpen(rec)){
   rec.lastExpected=expected;
   rec.lastPhysical=physicalNum;
   rec.lastDifference=0;
   rec.obs=c.obs||rec.obs||"";
   resolveDifferenceRecord(rec,"Reconteo cuadreado");
   c.historyId=rec.id;
 }
 return rec;
}
function archiveCurrentDigitalDifferences(){
 let touched=0;
 state.inventory.forEach(p=>{
   const c=state.digitalCounts[p.id];
   if(!c)return;
   if(c.physical===""||c.physical===null||c.physical===undefined)return;
   const before=(state.differenceHistory||[]).length;
   const rec=syncDifferenceHistoryFromDigital(p);
   if(rec||state.differenceHistory.length!==before)touched++;
 });
 return touched;
}
function reconcileOpenDifferencesFromDigital(){
 let touched=0;
 state.inventory.forEach(p=>{
   const c=state.digitalCounts[p.id];
   if(!c||c.physical===""||c.physical===null||c.physical===undefined)return;
   const rec=openDifferenceForProduct(p);
   if(!rec)return;
   const beforePhysical=Number(rec.physical);
   const beforeDifference=Number(rec.difference);
   syncDifferenceHistoryFromDigital(p);
   if(Number(rec.physical)!==beforePhysical||Number(rec.difference)!==beforeDifference)touched++;
 });
 return touched;
}
function differenceHistoryRows(view=differenceView){
 const list=(state.differenceHistory||[]).filter(r=>view==="history"||differenceRecordOpen(r));
 return [...list].sort((a,b)=>{
   const ad=new Date(a.detectedAt||0).getTime()||0;
   const bd=new Date(b.detectedAt||0).getTime()||0;
   return bd-ad;
 });
}
function currentProductForDifference(rec){
 return state.inventory.find(p=>
   (rec.productId&&p.id===rec.productId) ||
   normalizeImportCode(p.code)===normalizeImportCode(rec.code)
 )||null;
}
function currentCountLinkedToDifference(rec){
 const p=currentProductForDifference(rec);
 if(!p)return null;
 const c=state.digitalCounts[p.id];
 if(!c||c.historyId!==rec.id)return null;
 return {p,c};
}
function ensureDigitalDifferenceTimestamp(product){
 const c=state.digitalCounts[product.id];
 if(!c)return "";
 const physical=c.physical;
 if(physical===""||physical===null||physical===undefined)return "";
 const diff=digitalDiff(product,physical);

 if(diff!==0){
   if(!c.detectedAt)c.detectedAt=new Date().toISOString();
   syncDifferenceHistoryFromDigital(product);
   return c.detectedAt;
 }

 if(c.detectedAt)c.detectedAt="";
 syncDifferenceHistoryFromDigital(product);
 return "";
}
function digitalDifferenceDateTime(iso){
 if(!iso)return {date:"—",time:"—"};
 const d=new Date(iso);
 if(Number.isNaN(d.getTime()))return {date:"—",time:"—"};
 return {
   date:d.toLocaleDateString("es-GT",{day:"2-digit",month:"2-digit",year:"numeric"}),
   time:d.toLocaleTimeString("es-GT",{hour:"2-digit",minute:"2-digit",second:"2-digit"})
 };
}
function digitalDifferenceRows(){
 return state.inventory.map(p=>{
   const c=digitalCountState(p.id);
   const physical=c.physical;
   const diff=digitalDiff(p,physical);
   const st=digitalStatus(p,physical);
   const detectedAt=(physical!==""&&physical!==null&&physical!==undefined&&diff!==0)
     ? ensureDigitalDifferenceTimestamp(p)
     : "";
   return {p,c,physical,diff,st,detectedAt,responsible:c.responsible||state.digitalFilter.responsible||"—"};
 }).filter(x=>
   x.physical!=="" &&
   x.physical!==null &&
   x.physical!==undefined &&
   x.diff!==0
 );
}
function renderDiferencias(){
 reconcileOpenDifferencesFromDigital();
 const openRows=differenceHistoryRows("open");
 const rows=differenceHistoryRows(differenceView);
 const resolvedCount=(state.differenceHistory||[]).filter(r=>!differenceRecordOpen(r)).length;

 const tableRows=rows.map(rec=>{
   const dt=digitalDifferenceDateTime(rec.detectedAt);
   const resolvedDt=digitalDifferenceDateTime(rec.resolvedAt);
   const type=Number(rec.difference)>0?"Sobrante":"Faltante";
   const linked=currentCountLinkedToDifference(rec);
   const canAdjust=!!(
     linked &&
     linked.c.physical!=="" &&
     linked.c.physical!==null &&
     linked.c.physical!==undefined &&
     digitalDiff(linked.p,linked.c.physical)!==0
   );

   return `<tr>
     <td>${dt.date}</td>
     <td>${dt.time}</td>
     <td>${esc(rec.responsible||"—")}</td>
     <td>${esc(rec.family||"—")}</td>
     <td><b>${esc(rec.code||"—")}</b></td>
     <td>${esc(rec.catalog||"—")}</td>
     <td>${esc(rec.name||"—")}</td>
     <td class="qty">${Number(rec.expected||0)}</td>
     <td class="qty">${Number(rec.physical||0)}</td>
     <td class="qty">${Number(rec.difference)>0?"+":""}${Number(rec.difference||0)}</td>
     <td><span class="chip ${Number(rec.difference)>0?"count-surplus":"count-shortage"}">${type}</span></td>
     <td><span class="chip ${differenceRecordOpen(rec)?"pending":"count-balanced"}">${differenceRecordOpen(rec)?"Pendiente":"Resuelta"}</span></td>
     <td>${esc(rec.obs||"—")}</td>
     ${differenceView==="history"?`<td>${differenceRecordOpen(rec)?"—":`${resolvedDt.date} ${resolvedDt.time}`}<br><small>${esc(rec.resolution||"")}</small></td>`:""}
     <td>
       ${differenceRecordOpen(rec)?`<div class="table-actions difference-actions">
         <button class="mini-action review-action difference-action-btn" data-review-history="${rec.id}" title="Revisar diferencia" aria-label="Revisar diferencia"><span>↩</span><span class="action-label">Revisar</span></button>
         ${canAdjust?`<button class="mini-action adjust-action difference-action-btn" data-adjust-difference="${linked.p.id}" title="Ajustar inventario con el conteo actual" aria-label="Ajustar inventario"><span>↔</span><span class="action-label">Ajustar</span></button>`:""}
       </div>`:"—"}
     </td>
   </tr>`;
 }).join("");

 return `<section class="panel">
   <div class="panel-head differences-head">
     <div>
       <h2>Diferencias de Inventario Digital</h2>
       <p>${openRows.length} diferencia(s) pendiente(s) · ${resolvedCount} resuelta(s) · ${pendingDifferenceSyncCount()} pendiente(s) de respaldo. Una nueva importación no borra estos registros.</p>
     </div>
     <div class="difference-tabs">
       <button class="btn ${differenceView==="open"?"primary":"tonal"}" data-difference-view="open">Pendientes (${openRows.length})</button>
       <button class="btn ${differenceView==="history"?"primary":"tonal"}" data-difference-view="history">Historial (${state.differenceHistory.length})</button>
     </div>
   </div>

   <div class="difference-help" role="note">
     <div><b>Cómo leer esta pantalla</b><span>Físico actual es el último conteo guardado. Dif. actual = Físico − Exist. al detectar.</span></div>
     <div class="difference-help-legend"><span class="diff-negative">− Faltante</span><span class="diff-positive">+ Sobrante</span><span>↩ Revisar</span><span>↔ Ajustar stock</span></div>
   </div>

   ${rows.length?`
     <div class="table-wrap">
       <table class="differences-digital-table persistent-differences-table">
         <thead>
           <tr>
             <th>Fecha</th>
             <th>Hora</th>
             <th>Responsable</th>
             <th>Familia</th>
             <th>Código</th>
             <th>Catálogo</th>
             <th>Descripción</th>
             <th>Exist. al detectar</th>
             <th>Físico actual</th>
             <th>Dif. actual</th>
             <th>Tipo</th>
             <th>Seguimiento</th>
             <th>Obs.</th>
             ${differenceView==="history"?"<th>Resolución</th>":""}
             <th>Acc.</th>
           </tr>
         </thead>
         <tbody>${tableRows}</tbody>
       </table>
     </div>
   `:`
     <div class="empty">
       ${differenceView==="open"
         ? "No hay diferencias pendientes."
         : "Todavía no existe historial de diferencias."
       }
     </div>
   `}
 </section>`;
}
function renderSinExist(){
 const items=orderedProducts(state.inventory.filter(p=>Number(p.stock||0)<=0));
 const rows=items.map(p=>{
   const rec=activeStockoutForCode(p.code);
   const dt=stockoutDateTime(rec?.detectedAt||"");
   const rowCounted=c.physical!=="";
   const rowClass=rowCounted?"digital-row-counted":"";
   return `<tr class="${rowClass}" data-digital-row="${p.id}">
     <td><div class="table-actions"><button class="mini-action" data-view-product="${p.id}" title="Ver detalle">◉</button></div></td>
     <td>${dt.date}</td>
     <td>${dt.time}</td>
     <td><b>${esc(p.code)}</b></td>
     <td>${esc(p.catalog||"—")}</td>
     <td>${esc(p.name||"—")}</td>
     <td>${esc(p.family||"—")}</td>
     <td class="qty">0</td>
     <td class="qty">${Number(p.min||0)}</td>
     <td class="qty">${Number(p.max||0)}</td>
     <td class="qty">${Math.max(0,Number(p.max||0))}</td>
     <td>${esc(p.location||"—")}</td>
     <td><span class="chip zero">Sin existencia</span></td>
   </tr>`;
 }).join("");

 return `<section class="panel stockout-panel">
   <div class="panel-head">
     <div>
       <h2>Sin Existencia</h2>
       <p>${items.length} producto(s) agotado(s). La fecha y hora indican cuándo el sistema detectó la existencia en cero.</p>
     </div>
   </div>
   ${items.length?`<div class="table-wrap"><table class="stockout-table">
     <thead><tr>
       <th>Acc.</th><th>Fecha</th><th>Hora</th><th>Código</th><th>Catálogo</th>
       <th>Descripción</th><th>Familia</th><th>Exist.</th><th>Mín.</th><th>Máx.</th>
       <th>Reposición</th><th>Ubicación</th><th>Estado</th>
     </tr></thead>
     <tbody>${rows}</tbody>
   </table></div>`:`<div class="empty">No hay productos sin existencia.</div>`}
 </section>`;
}
function digitalFamilyKey(name){
 return String(name||"").trim();
}
function digitalFamilyClosed(name){
 const key=digitalFamilyKey(name);
 return !!(key && state.digitalClosedFamilies && state.digitalClosedFamilies[key]?.closed);
}
function digitalFamilySession(name){
 const key=digitalFamilyKey(name);
 return key ? (state.digitalClosedFamilies[key]||null) : null;
}
function closeDigitalFamily(){
 const family=digitalFamilyKey(state.digitalFilter.family);
 const responsible=String(state.digitalFilter.responsible||"").trim();
 if(!family)return toast("Selecciona una familia antes de cerrarla.");
 if(!responsible)return toast("No hay responsable asignado.");
 if(!confirm(`¿Cerrar la familia ${family}? El Inventario Digital volverá a quedar vacío.`))return;

 const archived=archiveDigitalFamily(family,"Cierre de familia",responsible);
 if(!state.digitalClosedFamilies)state.digitalClosedFamilies={};
 state.digitalClosedFamilies[family]={
   closed:true,
   responsible,
   closedAt:new Date().toISOString(),
   archiveId:archived?.id||state.digitalClosedFamilies[family]?.archiveId||""
 };

 state.digitalFilter={
   ...state.digitalFilter,
   family:"",
   search:"",
   responsible:"",
   condition:"none",
   value1:"",
   value2:""
 };
 save();
 render();
 toast(`Familia ${family} cerrada${archived?" y guardada en Historial":""}.`);
}
function reopenDigitalFamily(family,responsible=""){
 const key=digitalFamilyKey(family);
 if(!key)return;
 if(!state.digitalClosedFamilies)state.digitalClosedFamilies={};
 const previous=state.digitalClosedFamilies[key]||{};
 state.digitalClosedFamilies[key]={...previous,closed:false,reopenedAt:new Date().toISOString()};
 state.digitalFilter.responsible=responsible||previous.responsible||state.digitalFilter.responsible||"";
 state.digitalFilter.family=key;
 state.digitalFilter.search="";
 save();
}
function startNewDigitalFamilyCount(family,responsible=""){
 const key=digitalFamilyKey(family);
 if(!key)return false;
 const products=state.inventory.filter(p=>digitalFamilyKey(p.family)===key);
 const ids=new Set(products.map(p=>String(p.id)));
 (state.differenceHistory||[]).forEach(rec=>{
   if(differenceRecordOpen(rec)&&(ids.has(String(rec.productId||""))||digitalFamilyKey(rec.family)===key)){
     resolveDifferenceRecord(rec,"Conteo anterior archivado; se inició una nueva sesión de Inventario Digital");
   }
 });
 products.forEach(p=>{delete state.digitalCounts[p.id];});
 if(!state.digitalClosedFamilies)state.digitalClosedFamilies={};
 const previous=state.digitalClosedFamilies[key]||{};
 state.digitalClosedFamilies[key]={...previous,closed:false,reopenedAt:new Date().toISOString(),newSessionAt:new Date().toISOString()};
 state.digitalFilter={...state.digitalFilter,responsible:responsible||previous.responsible||"",family:key,search:"",condition:"none",value1:"",value2:""};
 save();
 return true;
}
function digitalFamilies(){
 return [...new Set(state.inventory.map(p=>String(p.family||"").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"es"));
}
function digitalCountState(productId){
 const c=state.digitalCounts[productId]||{};
 return {
   physical:c.physical===0?0:(c.physical??""),
   obs:c.obs||"",
   detectedAt:c.detectedAt||"",
   responsible:c.responsible||state.digitalFilter.responsible||""
 };
}
function digitalDiff(product,physical){
 if(physical===""||physical===null||physical===undefined)return "";
 const n=Number(physical);if(Number.isNaN(n))return "";
 return n-(+product.stock||0);
}
function digitalStatus(product,physical){
 if(physical===""||physical===null||physical===undefined)return {text:"Pendiente",cls:"pending"};
 const d=digitalDiff(product,physical);
 if(d===0)return {text:"Cuadreado",cls:"count-balanced"};
 if(d>0)return {text:"Sobrante",cls:"count-surplus"};
 return {text:"Faltante",cls:"count-shortage"};
}
function valueForDigitalField(p,field){
 if(field==="code")return p.code||"";
 if(field==="catalog")return p.catalog||"";
 if(field==="name")return p.name||"";
 if(field==="family")return p.family||"";
 if(field==="stock")return Number(p.stock||0);
 if(field==="location")return p.location||"";
 return "";
}
function applyDigitalCondition(items){
 const field=state.digitalFilter.field||"name";
 const cond=state.digitalFilter.condition||"none";
 const raw1=String(state.digitalFilter.value1||"").trim();
 const raw2=String(state.digitalFilter.value2||"").trim();
 if(cond==="none")return items;

 return items.filter(p=>{
   const original=valueForDigitalField(p,field);
   const str=String(original??"").trim();
   const s=str.toLowerCase(),v1=raw1.toLowerCase(),v2=raw2.toLowerCase();
   const num=Number(original),n1=Number(raw1),n2=Number(raw2);
   const isNum=field==="stock"&&!Number.isNaN(num);

   if(cond==="empty")return str==="";
   if(cond==="not_empty")return str!=="";
   if(cond==="contains")return s.includes(v1);
   if(cond==="not_contains")return !s.includes(v1);
   if(cond==="starts")return s.startsWith(v1);
   if(cond==="ends")return s.endsWith(v1);
   if(cond==="exact")return s===v1;
   if(cond==="gt")return isNum?num>n1:s>v1;
   if(cond==="gte")return isNum?num>=n1:s>=v1;
   if(cond==="lt")return isNum?num<n1:s<v1;
   if(cond==="lte")return isNum?num<=n1:s<=v1;
   if(cond==="eq")return isNum?num===n1:s===v1;
   if(cond==="neq")return isNum?num!==n1:s!==v1;
   if(cond==="between")return isNum?num>=n1&&num<=n2:s>=v1&&s<=v2;
   return true;
 });
}
function digitalFilteredProducts(){
 if(!String(state.digitalFilter.responsible||"").trim())return [];
 const family=String(state.digitalFilter.family||"").trim();
 if(!family)return [];
 let items=orderedProducts(state.inventory.filter(p=>String(p.family||"")===family));

 const q=String(state.digitalFilter.search||"").trim().toLowerCase();
 if(q){
   items=items.filter(p=>`${p.code} ${p.catalog||""} ${p.name} ${p.family||""} ${p.location||""}`.toLowerCase().includes(q));
 }
 return orderedProducts(applyDigitalCondition(items));
}
function digitalRows(items=digitalFilteredProducts()){
 if(!state.digitalFilter.responsible){
   return `<tr><td colspan="12"><div class="empty">Asigna el responsable del conteo físico antes de seleccionar una familia.</div></td></tr>`;
 }
 if(!state.digitalFilter.family){
   return `<tr><td colspan="12"><div class="empty">Selecciona una familia para cargar el Inventario Digital.</div></td></tr>`;
 }
 if(!items.length){
   return `<tr><td colspan="12"><div class="empty">No hay productos que coincidan con la búsqueda o filtro.</div></td></tr>`;
 }
 return items.map(p=>{
   const c=digitalCountState(p.id),st=digitalStatus(p,c.physical);
   const diff=digitalDiff(p,c.physical);
   const diffText=diff===""?"—":`${Number(diff)>0?"+":""}${Number(diff)}`;
   const diffCls=diff===""?"is-empty":Number(diff)===0?"is-zero":Number(diff)>0?"is-positive":"is-negative";
   const familyClosed=digitalFamilyClosed(state.digitalFilter.family);
   const disabled=familyClosed?"disabled":"";
   return `<tr>
     <td><div class="table-actions"><button class="mini-action" data-view-product="${p.id}" title="Ver detalle">◉</button></div></td>
     <td><b>${esc(p.code)}</b></td>
     <td>${esc(p.catalog||"—")}</td>
     <td>${esc(p.name)}</td>
     <td>${esc(p.family||"—")}</td>
     <td class="qty">${p.stock}</td>
     <td><input class="digital-physical no-spinner" type="number" min="0" inputmode="numeric" value="${c.physical===""?"":esc(c.physical)}" placeholder="0" data-digital-physical="${p.id}" ${disabled}></td>
     <td class="digital-calc-cell"><button type="button" class="digital-calc-row-btn" data-digital-calc="${p.id}" title="Abrir calculadora para ${esc(p.code)}" aria-label="Abrir calculadora para ${esc(p.code)}" ${disabled}>🧮</button></td>
     <td class="qty digital-diff-cell"><span class="digital-diff-value ${diffCls}" data-digital-diff="${p.id}">${diffText}</span></td>
     <td>${esc(p.location||"—")}</td>
     <td><span class="chip ${st.cls}" data-digital-status="${p.id}">${st.text}</span></td>
     <td><input class="digital-obs" type="text" value="${esc(c.obs)}" placeholder="Observación..." data-digital-obs="${p.id}" ${disabled}></td>
   </tr>`;
 }).join("");
}
function digitalConditionMenu(){
 return `<div class="drop-wrap digital-filter-wrap">
   <button class="toolbar-btn" id="digitalConditionBtn" ${state.digitalFilter.responsible&&state.digitalFilter.family?"":"disabled"}>
     🔎 Filtro por condición <span>⌄</span>
   </button>
   <div class="drop-menu digital-filter-menu" id="digitalConditionMenu" hidden>
     <div class="menu-title">
       <b>Filtrar por condición</b>
       <small>Aplica el filtro dentro de la familia seleccionada.</small>
     </div>
     <label>Campo
       <select id="digitalConditionField">
         <option value="code" ${state.digitalFilter.field==="code"?"selected":""}>Código</option>
         <option value="catalog" ${state.digitalFilter.field==="catalog"?"selected":""}>Catálogo</option>
         <option value="name" ${state.digitalFilter.field==="name"?"selected":""}>Descripción</option>
         <option value="family" ${state.digitalFilter.field==="family"?"selected":""}>Familia</option>
         <option value="stock" ${state.digitalFilter.field==="stock"?"selected":""}>Existencia</option>
         <option value="location" ${state.digitalFilter.field==="location"?"selected":""}>Ubicación</option>
       </select>
     </label>
     <label>Condición
       <select id="digitalConditionType">
         <option value="none" ${state.digitalFilter.condition==="none"?"selected":""}>Ninguno</option>
         <option value="empty" ${state.digitalFilter.condition==="empty"?"selected":""}>Está vacío</option>
         <option value="not_empty" ${state.digitalFilter.condition==="not_empty"?"selected":""}>No está vacío</option>
         <option value="contains" ${state.digitalFilter.condition==="contains"?"selected":""}>El texto contiene</option>
         <option value="not_contains" ${state.digitalFilter.condition==="not_contains"?"selected":""}>El texto no contiene</option>
         <option value="starts" ${state.digitalFilter.condition==="starts"?"selected":""}>El texto comienza con</option>
         <option value="ends" ${state.digitalFilter.condition==="ends"?"selected":""}>El texto termina con</option>
         <option value="exact" ${state.digitalFilter.condition==="exact"?"selected":""}>El texto es exactamente</option>
         <option value="gt" ${state.digitalFilter.condition==="gt"?"selected":""}>Mayor que</option>
         <option value="gte" ${state.digitalFilter.condition==="gte"?"selected":""}>Mayor o igual que</option>
         <option value="lt" ${state.digitalFilter.condition==="lt"?"selected":""}>Menor que</option>
         <option value="lte" ${state.digitalFilter.condition==="lte"?"selected":""}>Menor o igual que</option>
         <option value="eq" ${state.digitalFilter.condition==="eq"?"selected":""}>Es igual a</option>
         <option value="neq" ${state.digitalFilter.condition==="neq"?"selected":""}>No es igual a</option>
         <option value="between" ${state.digitalFilter.condition==="between"?"selected":""}>Está entre</option>
       </select>
     </label>
     <div class="condition-values">
       <label>Valor<input id="digitalConditionValue1" value="${esc(state.digitalFilter.value1||"")}" placeholder="Valor..."></label>
       <label id="digitalValue2Wrap">Valor 2<input id="digitalConditionValue2" value="${esc(state.digitalFilter.value2||"")}" placeholder="Segundo valor..."></label>
     </div>
     <div class="digital-filter-actions">
       <button class="menu-line" id="clearDigitalCondition">🧹 Limpiar filtro</button>
       <button class="menu-line primary-line" id="applyDigitalCondition">✓ Aplicar filtro</button>
     </div>
   </div>
 </div>`;
}
function printDigitalFamilySheet(){
 const family=String(state.digitalFilter.family||"").trim();
 if(!family)return toast("Selecciona una familia para imprimir.");

 const items=orderedProducts(
   state.inventory.filter(p=>String(p.family||"")===family)
 );

 if(!items.length)return toast("No hay productos en esta familia.");

 const responsible=String(state.digitalFilter.responsible||"").trim();
 const printedAt=new Date().toLocaleString("es-GT");
 const rows=items.map(p=>`<tr>
   <td>${esc(p.code||"")}</td>
   <td>${esc(p.catalog||"")}</td>
   <td>${esc(p.name||"")}</td>
   <td>${esc(p.family||"")}</td>
   <td>${Number(p.stock||0)}</td>
   <td class="write-cell"></td>
   <td class="write-cell obs-cell"></td>
 </tr>`).join("");

 const w=window.open("","_blank","width=900,height=1100");
 if(!w)return toast("El navegador bloqueó la ventana de impresión.");

 w.document.write(`<!doctype html><html><head><meta charset="utf-8">
 <title>Inventario Digital - ${esc(family)}</title>
 <style>
   @page{size:A4 portrait;margin:9mm}
   *{box-sizing:border-box}
   body{font-family:Arial,sans-serif;color:#111;margin:0;font-size:10px}
   h1{font-size:18px;margin:0 0 3px}
   .meta{font-size:10px;margin:0 0 10px;color:#444}
   table{width:100%;border-collapse:collapse;table-layout:auto}
   thead{display:table-header-group}
   tr{page-break-inside:avoid}
   th,td{border:1px solid #555;padding:4px 5px;vertical-align:middle}
   th:nth-child(1),td:nth-child(1),th:nth-child(2),td:nth-child(2),th:nth-child(3),td:nth-child(3){white-space:nowrap}
   th{font-size:9px;background:#eee;text-align:center}
   td{height:8mm}
   th:nth-child(1),td:nth-child(1){width:14%}
   th:nth-child(2),td:nth-child(2){width:13%}
   th:nth-child(3),td:nth-child(3){width:31%}
   th:nth-child(4),td:nth-child(4){width:10%}
   th:nth-child(5),td:nth-child(5){width:8%;text-align:center}
   th:nth-child(6),td:nth-child(6){width:9%}
   th:nth-child(7),td:nth-child(7){width:15%}
   .write-cell{background:#fff}
   .obs-cell{min-height:8mm}
 </style></head><body>
 <h1>Inventario Digital · ${esc(family)}</h1>
 <div class="meta">Responsable: ${esc(responsible||"________________________")} · Impreso: ${esc(printedAt)}</div>
 <table>
   <thead><tr>
     <th>Código</th>
     <th>Catálogo</th>
     <th>Descripción</th>
     <th>Familia</th>
     <th>Exist.</th>
     <th>Físico</th>
     <th>Obser.</th>
   </tr></thead>
   <tbody>${rows}</tbody>
 </table>
 <script>window.onload=()=>setTimeout(()=>window.print(),150)<\/script>
 </body></html>`);
 w.document.close();
}
function renderDigital(){
 if(digitalView==="history")return renderDigitalHistory();
 const fams=digitalFamilies(),items=digitalFilteredProducts();
 const counted=items.filter(p=>digitalCountState(p.id).physical!=="").length;
 const diffs=items.filter(p=>{const c=digitalCountState(p.id);return c.physical!==""&&digitalDiff(p,c.physical)!==0}).length;

 return `<section class="panel digital-panel">
   <div class="panel-head digital-head">
     <div>
       <h2>Inventario Digital</h2>
       <p>${state.digitalFilter.responsible
         ? `Responsable: ${esc(state.digitalFilter.responsible)}${state.digitalFilter.family?` · ${esc(state.digitalFilter.family)} · ${items.length} producto(s) · ${counted} contados · ${diffs} con diferencia${digitalFamilyClosed(state.digitalFilter.family)?" · 🔒 Familia cerrada":""}`:" · Selecciona una familia para comenzar."}`
         : "Asigna primero el responsable del conteo físico."
       }</p>
       ${digitalHistoryTabs()}
     </div>
     <div class="digital-tools">
       <button class="toolbar-btn responsible-btn" id="digitalResponsibleBtn">
         👤 ${state.digitalFilter.responsible?`Responsable: ${esc(state.digitalFilter.responsible)}`:"Asignar responsable"}
       </button>
       <select id="digitalFamilySelect" class="digital-family-select" ${state.digitalFilter.responsible?"":"disabled"}>
         <option value="">Seleccionar familia...</option>
         ${fams.map(f=>`<option value="${esc(f)}" ${state.digitalFilter.family===f?"selected":""}>${esc(f)}</option>`).join("")}
       </select>
       <div class="digital-search"><span>⌕</span><input id="digitalSearchInput" placeholder="Buscar..." value="${esc(state.digitalFilter.search||"")}" ${state.digitalFilter.responsible&&state.digitalFilter.family?"":"disabled"}></div>
       ${digitalConditionMenu()}
       <button class="toolbar-btn digital-calculator-open" id="digitalCalculatorBtn" ${state.digitalFilter.responsible&&state.digitalFilter.family?"":"disabled"}>
         🧮 Calculadora
       </button>
       <button class="toolbar-btn" id="printDigitalFamilyBtn" ${state.digitalFilter.responsible&&state.digitalFilter.family?"":"disabled"}>
         🖨️ Imprimir familia
       </button>
       <button class="toolbar-btn close-family-btn" id="closeDigitalFamilyBtn" ${state.digitalFilter.responsible&&state.digitalFilter.family&&!digitalFamilyClosed(state.digitalFilter.family)?"":"disabled"}>
         🔒 Cerrar familia
       </button>
     </div>
   </div>

   <div class="table-wrap"><table class="digital-table">
     <thead><tr>
       <th>Acc.</th>
       <th>Código</th>
       <th>Catálogo</th>
       <th>Descripción</th>
       <th>Familia</th>
       <th>Exist.</th>
       <th>Físico (editable)</th>
       <th>Calc.</th>
       <th>Dif.</th>
       <th>Ubicación</th>
       <th>Estado</th>
       <th>Obs. (editable)</th>
     </tr></thead>
     <tbody>${digitalRows(items)}</tbody>
   </table></div>

   <dialog id="digitalCalculatorDialog" class="digital-calculator-dialog" aria-labelledby="digitalCalculatorTitle">
     <div class="digital-calculator-shell">
       <div class="digital-calculator-head">
         <div>
           <small>INVENTARIO DIGITAL</small>
           <h3 id="digitalCalculatorTitle">🧮 Calculadora de conteo</h3>
           <p id="digitalCalculatorTarget">Selecciona una fila para enviar el resultado a Físico.</p>
         </div>
         <button type="button" class="icon-btn" id="digitalCalculatorClose" aria-label="Cerrar calculadora">×</button>
       </div>
       <div class="digital-calculator-display" id="digitalCalculatorDisplay" aria-live="polite">0</div>
       <div class="digital-calculator-expression" id="digitalCalculatorExpression">Listo para calcular</div>
       <div class="digital-calculator-grid" role="group" aria-label="Teclado de calculadora">
         <button type="button" class="calc-key calc-key-soft" data-calc-action="clear">C</button>
         <button type="button" class="calc-key calc-key-soft" data-calc-action="backspace">⌫</button>
         <button type="button" class="calc-key calc-key-op" data-calc-op="/">÷</button>
         <button type="button" class="calc-key calc-key-op" data-calc-op="*">×</button>
         <button type="button" class="calc-key" data-calc-digit="7">7</button>
         <button type="button" class="calc-key" data-calc-digit="8">8</button>
         <button type="button" class="calc-key" data-calc-digit="9">9</button>
         <button type="button" class="calc-key calc-key-op" data-calc-op="-">−</button>
         <button type="button" class="calc-key" data-calc-digit="4">4</button>
         <button type="button" class="calc-key" data-calc-digit="5">5</button>
         <button type="button" class="calc-key" data-calc-digit="6">6</button>
         <button type="button" class="calc-key calc-key-op" data-calc-op="+">+</button>
         <button type="button" class="calc-key" data-calc-digit="1">1</button>
         <button type="button" class="calc-key" data-calc-digit="2">2</button>
         <button type="button" class="calc-key" data-calc-digit="3">3</button>
         <button type="button" class="calc-key calc-key-equals" data-calc-action="equals">=</button>
         <button type="button" class="calc-key calc-key-zero" data-calc-digit="0">0</button>
         <button type="button" class="calc-key" data-calc-digit="00">00</button>
       </div>
       <div class="digital-calculator-actions">
         <button type="button" class="btn ghost" id="digitalCalculatorReset">Limpiar</button>
         <button type="button" class="btn primary" id="digitalCalculatorUse">✓ Usar resultado en Físico</button>
       </div>
       <p class="digital-calculator-note">Teclado PC: números, +, −, *, /, Enter o =, Backspace, C y Esc. Ejemplo: 12 × 4 + 3 = 51.</p>
     </div>
   </dialog>
 </section>`;
}
function pendingBaseRows(){
 if(!state.pendingBaseProducts.length){
   return `<tr><td colspan="8"><div class="empty">No hay códigos nuevos pendientes. Los códigos que no existan en BASE_PRODUCTOS aparecerán aquí después de importar un inventario.</div></td></tr>`;
 }
 return [...state.pendingBaseProducts].sort((a,b)=>normalizeMasterOrderValue(a.importOrder)-normalizeMasterOrderValue(b.importOrder)).map((p,i)=>`<tr>
   <td><b>${esc(p.code)}</b></td>
   <td><input class="pending-base-input" data-pending-index="${i}" data-pending-field="catalog" value="${esc(p.catalog||"")}" placeholder="Catálogo"></td>
   <td><input class="pending-base-input pending-desc" data-pending-index="${i}" data-pending-field="description" value="${esc(p.description||"")}" placeholder="Descripción"></td>
   <td><input class="pending-base-input" data-pending-index="${i}" data-pending-field="family" value="${esc(p.family||"")}" placeholder="Familia"></td>
   <td><input class="pending-base-number no-spinner" type="number" min="0" data-pending-index="${i}" data-pending-field="min" value="${Number(p.min||0)}"></td>
   <td><input class="pending-base-number no-spinner" type="number" min="0" data-pending-index="${i}" data-pending-field="max" value="${Number(p.max||0)}"></td>
   <td><span class="chip pending">Pendiente</span></td>
   <td><button class="mini-action save-new-base" data-save-base-index="${i}" title="Guardar en BASE_PRODUCTOS">💾</button></td>
 </tr>`).join("");
}
function renderNuevos(){
 const total=state.pendingBaseProducts.length,queued=state.baseProductSyncQueue.length;
 return `<section class="panel newcodes-panel">
   <div class="panel-head newcodes-head">
     <div>
       <h2>Códigos Nuevos</h2>
       <p>${total} código(s) pendiente(s) de completar · <span id="baseQueueStatus">${queued?`${queued} guardado(s) en PC pendiente(s) de sincronizar`:"Todo sincronizado con BASE_PRODUCTOS"}</span>.</p>
     </div>
     <div class="actions">
       <button class="btn tonal" id="refreshBasePending">↻ Verificar nuevamente</button>
       <button class="btn tonal" id="syncBaseQueueNow" ${queued?"":"disabled"}>☁ Sincronizar ahora (<span id="baseQueueCount">${queued}</span>)</button>
       <button class="btn tonal" id="testBaseWriteSupport">✓ Comprobar guardado Sheets</button>
       <button class="btn primary" id="saveAllNewBase" ${total?"":"disabled"}>💾 Guardar todos en PC</button>
     </div>
   </div>
   <div class="newcodes-note">
     <b>Catálogo es opcional.</b>
     Completa Descripción, Familia, Mín. y Máx. Al guardar, primero queda almacenado en esta PC y después se sincroniza automáticamente con Google Sheets → BASE_PRODUCTOS.
   </div>
   <div class="table-wrap"><table class="newcodes-table">
     <thead><tr><th>Código</th><th>Catálogo</th><th>Descripción</th><th>Familia</th><th>Mín.</th><th>Máx.</th><th>Estado</th><th>Acc.</th></tr></thead>
     <tbody>${pendingBaseRows()}</tbody>
   </table></div>
 </section>`;
}
let systemDiagnosticsResult=null;
function diagnosticRow(ok,label,detail=""){
 return `<div class="diagnostic-row ${ok?"diag-ok":"diag-warn"}">
   <span>${ok?"✓":"!"}</span>
   <div><b>${esc(label)}</b>${detail?`<small>${esc(detail)}</small>`:""}</div>
 </div>`;
}
function systemDiagnosticsHtml(){
 if(!systemDiagnosticsResult)return "";
 return `<div class="diagnostics-card">
   <div class="panel-head"><div><h3>Diagnóstico del sistema</h3><p>${esc(systemDiagnosticsResult.summary)}</p></div></div>
   <div class="diagnostic-list">${systemDiagnosticsResult.rows.join("")}</div>
 </div>`;
}
async function runSystemDiagnostics(){
 const rows=[];
 let warnings=0;

 try{
   const key="__bodega_test__";
   localStorage.setItem(key,"1");
   const ok=localStorage.getItem(key)==="1";
   localStorage.removeItem(key);
   rows.push(diagnosticRow(ok,"Almacenamiento del navegador",ok?"Disponible":"No disponible"));
   if(!ok)warnings++;
 }catch(err){
   rows.push(diagnosticRow(false,"Almacenamiento del navegador","Bloqueado por el navegador"));
   warnings++;
 }

 const duplicateCodes=state.inventory
   .map(p=>stockoutCode(p.code))
   .filter((c,i,a)=>c&&a.indexOf(c)!==i);
 rows.push(diagnosticRow(!duplicateCodes.length,"Códigos duplicados",
   duplicateCodes.length?`${new Set(duplicateCodes).size} duplicado(s)`:"Sin duplicados"));
 if(duplicateCodes.length)warnings++;

 const invalidProducts=state.inventory.filter(p=>
   !String(p.code||"").trim() ||
   !String(p.name||"").trim() ||
   Number(p.min||0)<0 ||
   Number(p.max||0)<Number(p.min||0)
 );
 rows.push(diagnosticRow(!invalidProducts.length,"Integridad del Inventario",
   invalidProducts.length?`${invalidProducts.length} producto(s) requieren revisión`:`${state.inventory.length} producto(s) válidos`));
 if(invalidProducts.length)warnings++;

 rows.push(diagnosticRow(!state.baseProductSyncQueue.length,"Cola BASE_PRODUCTOS",
   state.baseProductSyncQueue.length?`${state.baseProductSyncQueue.length} pendiente(s) de sincronizar`:"Sin pendientes"));
 if(state.baseProductSyncQueue.length)warnings++;

 if(cloudConfig.enabled&&cloudReady()){
   try{
     const ping=await cloudJsonp("ping");
     const ok=!!ping?.ok;
     rows.push(diagnosticRow(ok,"Conexión central",ok?String(ping.version||"Conectado"):"Respuesta inválida"));
     if(!ok)warnings++;

     const staff=await getCentralStaff();
     rows.push(diagnosticRow(true,"Personal central",
       `${staff.technicians.length} técnico(s) · ${staff.keepers.length} bodeguero(s)`));

     const base=await getBaseProductsFromSheets();
     rows.push(diagnosticRow(true,"BASE_PRODUCTOS",`${base.size} código(s) disponibles`));
   }catch(err){
     rows.push(diagnosticRow(false,"Google Sheets / Netlify",String(err?.message||"Error de conexión")));
     warnings++;
   }
 }else{
   rows.push(diagnosticRow(false,"Base central","No está activada o configurada"));
   warnings++;
 }

 systemDiagnosticsResult={
   rows,
   summary:warnings?`${warnings} punto(s) necesitan atención.`:"Todo lo revisado está funcionando correctamente."
 };
 render();
}
async function syncEverythingNow(){
 if(!cloudConfig.enabled||!cloudReady())return toast("Conecta la base central en Configuración.");
 try{
   toast("Sincronizando todo...");
   if(state.baseProductSyncQueue?.length)await syncBaseProductQueue();
   await syncCentralStaff(true);
   clearTimeout(cloudSyncTimer);
   const ok=await syncToCloud(false);
   if(ok)toast("Todo quedó sincronizado con la base central.");
 }catch(err){
   console.error(err);
   toast(err?.message||"No se pudo completar la sincronización.");
 }
}
function renderHerramientas(){return `<section class="panel tools-panel">
 <div class="panel-head"><div><h2>Herramientas</h2><p>Importación, exportación y respaldo del sistema.</p></div></div>

 <div class="quick-grid">
   <button class="quick import-inventory-tool" data-tool="import-inventory">
     📥
     <b>Importar inventario TXT</b>
     <small>Artículo → Código · PR → Familia · Descripción y Existencia desde el reporte.</small>
     <span class="quick-note">Catálogo, Mín., Máx. y Reposición se guardan y consultan en BASE_PRODUCTOS.</span>
   </button>

   <button class="quick" data-tool="csv">⇩<b>Exportar inventario</b><small>Archivo CSV.</small></button>
   <button class="quick" data-tool="backup">⤓<b>Copia de seguridad</b><small>Guarda productos, salidas y conteos en JSON.</small></button>
   <button class="quick" data-tool="reset">↻<b>Limpiar copia local</b><small>Limpia este navegador sin borrar Google Sheets. Si hay conexión, vuelve a cargar la base central.</small></button>
   <button class="quick" data-tool="sync-all">☁<b>Sincronizar todo</b><small>Guarda Inventario, Salidas, Conteos y pendientes en la base central.</small></button>
   <button class="quick" data-tool="diagnostics">🩺<b>Diagnóstico</b><small>Comprueba almacenamiento, datos y conexión central.</small></button>
 </div>

 <input type="file" id="inventoryTxtFile" accept=".txt,text/plain" hidden>

 <div class="import-help">
   <b>Formato esperado</b>
   <p>El archivo puede ser el reporte IRG077. El sistema toma <strong>PR, Artículo, Descripción y Existencia</strong>. No utiliza TI, MA ni el número interno que aparece después de Artículo.</p>
   <div class="actions" style="margin-top:10px">
     <button class="btn tonal" id="testBaseProductsBtn">✓ Probar BASE_PRODUCTOS</button>
   </div>
 </div>
 ${systemDiagnosticsHtml()}
 </section>`}
function validLogoDataUrl(value){
 return typeof value==="string"&&/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(value);
}
function applyBranding(){
 const name=state.settings.name||"Mi Bodega";
 const brandName=$("#brandName");
 if(brandName)brandName.textContent=name;
 const icon=$("#brandIcon");
 if(!icon)return;
 icon.replaceChildren();
 if(validLogoDataUrl(state.settings.logoDataUrl)){
   const img=document.createElement("img");
   img.src=state.settings.logoDataUrl;
   img.alt=`Logo ${name}`;
   icon.appendChild(img);
   icon.classList.add("has-logo");
 }else{
   icon.textContent="▣";
   icon.classList.remove("has-logo");
 }
}
function optimizeLogoFile(file){
 return new Promise((resolve,reject)=>{
   if(!file||!String(file.type||"").startsWith("image/"))return reject(new Error("Selecciona una imagen PNG, JPG o WEBP."));
   if(file.size>8*1024*1024)return reject(new Error("La imagen es demasiado grande. Máximo 8 MB."));
   const reader=new FileReader();
   reader.onerror=()=>reject(new Error("No se pudo leer la imagen."));
   reader.onload=()=>{
     const img=new Image();
     img.onerror=()=>reject(new Error("La imagen no es válida."));
     img.onload=()=>{
       try{
         const maxSide=320;
         const ratio=Math.min(1,maxSide/Math.max(img.naturalWidth||1,img.naturalHeight||1));
         let w=Math.max(1,Math.round(img.naturalWidth*ratio));
         let h=Math.max(1,Math.round(img.naturalHeight*ratio));
         const draw=(ww,hh,quality=.88)=>{
           const canvas=document.createElement("canvas");
           canvas.width=ww;canvas.height=hh;
           const ctx=canvas.getContext("2d");
           ctx.clearRect(0,0,ww,hh);
           ctx.imageSmoothingEnabled=true;
           ctx.imageSmoothingQuality="high";
           ctx.drawImage(img,0,0,ww,hh);
           let data=canvas.toDataURL("image/webp",quality);
           if(!/^data:image\/webp/i.test(data))data=canvas.toDataURL("image/png");
           return data;
         };
         let data=draw(w,h,.88);
         if(data.length>190000){
           const scale=.72;
           w=Math.max(1,Math.round(w*scale));
           h=Math.max(1,Math.round(h*scale));
           data=draw(w,h,.78);
         }
         if(data.length>260000)return reject(new Error("No se pudo optimizar suficiente el logo. Usa una imagen más simple."));
         resolve(data);
       }catch(err){reject(err)}
     };
     img.src=String(reader.result||"");
   };
   reader.readAsDataURL(file);
 });
}
function tags(list,type){return list.map((x,i)=>`<span class="tag">${esc(x)} <button data-remove-person="${type}:${i}">×</button></span>`).join("")}
function renderConfig(){return `<section class="panel"><div class="panel-head"><div><h2>Configuración</h2><p>Nombre, personal y base de datos central.</p></div></div>
 <div class="setting"><div><b>Nombre de la bodega</b><p>Nombre mostrado en el menú.</p></div><input id="cfgName" value="${esc(state.settings.name)}" style="max-width:260px"></div>

 <div class="setting logo-setting">
   <div class="logo-setting-copy">
     <b>Logo de la bodega</b>
     <p>Se muestra en el menú de PC, tablet y teléfono. El sistema lo optimiza automáticamente y lo sincroniza con la configuración central.</p>
   </div>
   <div class="logo-editor">
     <div class="logo-preview ${validLogoDataUrl(state.settings.logoDataUrl)?"has-logo":""}" id="logoPreview">
       ${validLogoDataUrl(state.settings.logoDataUrl)?`<img src="${esc(state.settings.logoDataUrl)}" alt="Logo de la bodega">`:`<span>▣</span>`}
     </div>
     <div class="logo-editor-actions">
       <input type="file" id="logoFileInput" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
       <button type="button" class="btn tonal" id="chooseLogoBtn">🖼️ Seleccionar logo</button>
       <button type="button" class="btn danger-soft" id="removeLogoBtn" ${validLogoDataUrl(state.settings.logoDataUrl)?"":"disabled"}>Quitar logo</button>
       <small>PNG, JPG o WEBP. Recomendado: imagen cuadrada o rectangular con fondo transparente.</small>
     </div>
   </div>
 </div>

 <div class="setting central-staff-setting"><div style="width:100%"><b>Técnicos · BASE_TECNICOS</b><p>Lista maestra guardada en Google Sheets. Se recupera aunque borres los datos del navegador.</p><div id="techTags" class="list-editor">${tags(state.settings.technicians,"tech")}</div><div class="actions" style="margin-top:8px"><input id="newTech" placeholder="Nuevo técnico" style="max-width:240px"><button class="btn tonal" id="addTech">Guardar técnico</button></div></div></div>

 <div class="setting central-staff-setting"><div style="width:100%"><b>Bodegueros · BASE_BODEGUEROS</b><p>Lista maestra guardada en Google Sheets y utilizada en todos los módulos.</p><div id="keeperTags" class="list-editor">${tags(state.settings.keepers,"keeper")}</div><div class="actions" style="margin-top:8px"><input id="newKeeper" placeholder="Nuevo bodeguero" style="max-width:240px"><button class="btn tonal" id="addKeeper">Guardar bodeguero</button><button class="btn tonal" id="refreshCentralStaff">↻ Recargar personal</button></div></div></div>

 <div class="cloud-db-card">
   <div class="cloud-db-head">
     <div>
       <small>BASE DE DATOS CENTRAL</small>
       <h3>Google Sheets</h3>
       <p>Usa la misma información en PC, Android y iPhone.</p>
     </div>
     <div class="cloud-status">
       <span id="cloudStatusDot" class="cloud-dot ${!cloudConfig.enabled?"local":cloudConfig.status==="ok"?"ok":cloudConfig.status==="syncing"?"syncing":cloudConfig.status==="error"?"error":"local"}"></span>
       <span id="cloudStatusText">${esc(cloudStatusLabel())}</span>
     </div>
   </div>

   <div class="cloud-grid">
     <label>URL de la Web App de Google Apps Script
       <input id="cloudUrl" type="url" placeholder="https://script.google.com/macros/s/.../exec" value="${esc(cloudConfig.url||"")}">
     </label>
     <label>Token de conexión · solo modo directo
       <input id="cloudToken" type="password" placeholder="En Proxy Netlify el Token vive solo en el servidor" value="${cloudConfig.proxy?"":esc(cloudConfig.token||"")}" ${cloudConfig.proxy?"disabled":""}>
     </label>
   </div>

   <label class="cloud-check">
     <input id="cloudProxy" type="checkbox" ${cloudConfig.proxy?"checked":""}>
     <span><b>Proxy Netlify · sin login</b><small>El Token permanece en Netlify y no se guarda en el navegador. No usa PIN ni sesión.</small></span>
   </label>
   <label class="cloud-check">
     <input id="cloudEnabled" type="checkbox" ${cloudConfig.enabled?"checked":""}>
     <span><b>Usar Google Sheets como base de datos</b><small>Al iniciar el sistema descargará la información central.</small></span>
   </label>
   <label class="cloud-check">
     <input id="cloudAutoSync" type="checkbox" ${cloudConfig.autoSync?"checked":""}>
     <span><b>Sincronización automática con Google Sheets</b><small>Guarda cada cambio en la hoja y revisa automáticamente si otro dispositivo hizo cambios.</small></span>
   </label>

   ${cloudConfig.proxy?`<div class="cloud-security-row"><div><b>☁️ Conexión estable sin login</b><small>Netlify conecta directamente con Google Sheets. Los cambios se guardan primero en este dispositivo y luego se sincronizan automáticamente.</small></div></div>`:""}

   <div class="cloud-actions">
     <button class="btn primary" id="saveCloudConnection">Guardar conexión</button>
     <button class="btn tonal" id="testCloudConnection">Probar conexión</button>
     <button class="btn tonal" id="pushCloudData">↑ Subir datos actuales</button>
     <button class="btn tonal" id="pullCloudData">↓ Descargar desde Sheets</button>
     <button class="btn danger-soft" id="disableCloud">Usar solo local</button>
   </div>

   <div class="cloud-help">
     <b>Instalación inicial</b>
     <p>Google Sheets es la base central. V80.3 no usa PIN ni sesiones. Cada cambio se guarda primero en este dispositivo y después se sincroniza automáticamente. Si Internet falla, el trabajo local queda pendiente y se sube antes de volver a descargar la base central.</p>
   </div>
 </div>

 <div class="factory-reset-card">
   <div>
     <small>ZONA DE SEGURIDAD</small>
     <h3>Restablecer sistema a fábrica</h3>
     <p>Borra Inventario, Salidas, Conteo Semanal, Inventario Digital, Diferencias, historiales, Sin Existencia, Códigos Nuevos, Técnicos y Bodegueros. <strong>BASE_PRODUCTOS se conserva</strong>, al igual que la conexión segura de Netlify.</p>
   </div>
   <button type="button" class="btn danger-soft factory-reset-btn" id="factoryResetBtn">⚠ Restablecer a fábrica</button>
 </div>

 <div class="actions" style="margin-top:14px"><button class="btn primary" id="saveCfg">Guardar configuración</button></div></section>`}
const renderers={inicio:renderInicio,inventario:renderInventario,salida:renderSalida,conteo:renderConteo,diferencias:renderDiferencias,sinexist:renderSinExist,digital:renderDigital,familias:renderFamiliesCounted,herramientas:renderHerramientas,nuevos:renderNuevos,config:renderConfig};
function isTouchTabletOrPhone(){
 const coarse=window.matchMedia&&window.matchMedia("(pointer: coarse)").matches;
 return window.innerWidth<=820||(window.innerWidth<=1100&&coarse);
}
function syncWeeklyStickyColumns(){
 const table=document.querySelector(".weekly-table");
 if(!table)return;
 const active=isTouchTabletOrPhone();
 if(!active){
   table.style.removeProperty("--weekly-code-sticky-width");
   return;
 }
 const first=table.querySelector("thead th:nth-child(1)")||table.querySelector("tbody td:nth-child(1)");
 if(!first)return;
 const width=Math.ceil(first.getBoundingClientRect().width);
 if(width>0)table.style.setProperty("--weekly-code-sticky-width",width+"px");
}
function syncDigitalStickyColumns(){
 const table=document.querySelector(".digital-table");
 if(!table)return;
 const active=isTouchTabletOrPhone();
 if(!active){
   table.style.removeProperty("--digital-acc-sticky-width");
   table.style.removeProperty("--digital-code-sticky-width");
   return;
 }
 const accCell=table.querySelector("thead th:nth-child(1)")||table.querySelector("tbody td:nth-child(1)");
 const codeCell=table.querySelector("thead th:nth-child(2)")||table.querySelector("tbody td:nth-child(2)");
 const accWidth=accCell?Math.ceil(accCell.getBoundingClientRect().width):68;
 const codeWidth=codeCell?Math.ceil(codeCell.getBoundingClientRect().width):128;
 if(accWidth>0)table.style.setProperty("--digital-acc-sticky-width",accWidth+"px");
 if(codeWidth>0)table.style.setProperty("--digital-code-sticky-width",codeWidth+"px");
}
function syncGlobalSearchVisibility(){
 const wrap=$("#globalSearchWrap");
 const input=$("#globalSearch");
 const topbar=document.querySelector(".topbar");
 const visible=state.page==="inventario";
 if(wrap)wrap.hidden=!visible;
 if(topbar)topbar.classList.toggle("search-hidden",!visible);
 if(!visible&&input&&input.value)input.value="";
}
function render(){
 applyBranding();
 $("#pageTitle").textContent=titles[state.page]||"Inicio";
 syncGlobalSearchVisibility();
 $("#content").innerHTML=(renderers[state.page]||renderInicio)();
 $$("[data-page]").forEach(b=>b.classList.toggle("active",b.dataset.page===state.page));
 const familiesBadge=$("#familiesCountBadge");
 if(familiesBadge){
   const n=digitalFamiliesOverviewRows().length;
   familiesBadge.textContent=String(n);
   familiesBadge.hidden=n===0;
 }
 bind();
 requestAnimationFrame(()=>{syncWeeklyStickyColumns();syncDigitalStickyColumns();});
 updateLiveStatusUI();
}
function nav(p){
 state.page=p;
 render();
 closeMenu();
 scrollTo({top:0,behavior:"smooth"});
}
function closeMenu(){
 const sidebar=$("#sidebar"),scrim=$("#scrim"),menuBtn=$("#menuBtn");
 sidebar?.classList.remove("open");
 scrim?.classList.remove("show");
 document.body.classList.remove("drawer-open");
 menuBtn?.setAttribute("aria-expanded","false");
}
function openMenu(){
 const sidebar=$("#sidebar"),scrim=$("#scrim"),menuBtn=$("#menuBtn");
 sidebar?.classList.add("open");
 scrim?.classList.add("show");
 document.body.classList.add("drawer-open");
 menuBtn?.setAttribute("aria-expanded","true");
}
function refreshProductReorder(){
 const stock=Math.max(0,Number($("#pStock")?.value||0));
 const max=Math.max(0,Number($("#pMax")?.value||0));
 const r=$("#pReorder");
 if(r)r.value=Math.max(0,max-stock);
}
function openProduct(p=null){
 editingProductId=p?.id||null;
 $("#productDialogTitle").textContent=p?"Editar producto":"Agregar producto";
 $("#pCode").value=p?.code||"";
 $("#pCode").readOnly=!!p;
 $("#pCode").classList.toggle("locked-field",!!p);
 $("#pCatalog").value=p?.catalog||"";
 $("#pName").value=p?.name||"";
 $("#pFamily").value=p?.family||"";
 $("#pLocation").value=p?.location||"";
 $("#pStock").value=p?.stock??0;
 $("#pMin").value=p?.min??0;
 $("#pMax").value=p?.max??0;
 refreshProductReorder();
 $("#productDialog").showModal();
 setTimeout(()=>{(p?$("#pCatalog"):$("#pCode"))?.focus()},40);
}
function openProductDetail(p){currentProductId=p.id;$("#pdTitle").textContent=p.name;$("#pdContent").innerHTML=[["Código",p.code],["Catálogo",p.catalog||"—"],["Descripción",p.name],["Familia",p.family||"—"],["Existencia",p.stock],["Mínimo",p.min],["Máximo",p.max],["Ubicación",p.location||"—"],["Reposición",p.reorder],["Estado",p.stock===0?"Sin existencia":p.stock<=p.min?"Stock bajo":"Disponible"]].map(x=>`<div class="detail-row"><span>${x[0]}</span><strong>${esc(x[1])}</strong></div>`).join("");$("#productDetailDialog").showModal()}
function openMovementDetail(m){currentMovementId=m.id;$("#mdTitle").textContent=`Salida ${m.code}`;$("#mdContent").innerHTML=[["Fecha",m.date],["Código",m.code],["Descripción",m.product],["Cantidad",m.qty],["Técnico",m.technician],["N. de Orden",m.orderNumber||"—"],["Estado",String(m.orderNumber||"").trim()?"Descargado":"PEND. DESCARGA"],["N. de Orden bloqueado",orderIsLocked(m)?"Sí":"No"],["Bodeguero",m.keeper]].map(x=>`<div class="detail-row"><span>${x[0]}</span><strong>${esc(x[1])}</strong></div>`).join("");$("#movementDetailDialog").showModal()}
function itemForMovement(m){return productByCode(m.code)||state.inventory.find(p=>p.name===m.product)}
function openQty(m){let p=itemForMovement(m);if(!p)return toast("No se encontró el producto.");editingMovementId=m.id;$("#eqCode").textContent=m.code;$("#eqName").textContent=m.product;$("#eqQty").value=m.qty;$("#eqQty").max=(+p.stock||0)+(+m.qty||0);$("#eqInfo").innerHTML=`Cantidad actual: <b>${m.qty}</b> · Existencia actual: <b>${p.stock}</b> · Máximo permitido: <b>${(+p.stock||0)+(+m.qty||0)}</b>`;$("#editQtyDialog").showModal();setTimeout(()=>$("#eqQty").select(),30)}
function bind(){
 $$("[data-go]").forEach(b=>b.onclick=()=>nav(b.dataset.go));
 $$('[data-families-page-view]').forEach(b=>b.onclick=()=>{digitalFamiliesPageView=b.dataset.familiesPageView==="history"?"history":"families";render();});
 $$('[data-family-history]').forEach(b=>b.onclick=async()=>{digitalHistorySelectedId=b.dataset.familyHistory||"";digitalFamiliesPageView="history";digitalHistoryLoadedArchive=null;render();await ensureDigitalArchiveLoaded(digitalHistorySelectedId,true);});
 $$('[data-print-family-history]').forEach(b=>b.onclick=()=>printDigitalHistoryArchive(digitalHistoryMetaById(b.dataset.printFamilyHistory)));
 $$('[data-open-counted-family]').forEach(b=>b.onclick=()=>{const fam=b.dataset.openCountedFamily||"";const resp=b.dataset.responsible||"";state.digitalFilter.responsible=resp||state.digitalFilter.responsible||"";state.digitalFilter.family=fam;state.digitalFilter.search="";digitalView="current";saveLocal();nav("digital");});
 $$('[data-new-counted-family]').forEach(b=>b.onclick=()=>{const fam=b.dataset.newCountedFamily||"";if(!fam)return;if(!confirm(`¿Iniciar un NUEVO conteo de la familia ${fam} con las existencias actuales?\n\nEl historial anterior quedará intacto y el Físico actual de esta familia comenzará vacío.`))return;startNewDigitalFamilyCount(fam,b.dataset.responsible||"");digitalView="current";nav("digital");toast(`Nuevo conteo iniciado para ${fam}.`);});
 const familiesHist=$("#familiesHistorySelect"); if(familiesHist)familiesHist.onchange=async()=>{digitalHistorySelectedId=familiesHist.value;digitalHistoryLoadedArchive=null;render();await ensureDigitalArchiveLoaded(digitalHistorySelectedId,true);};
 const familiesPrint=$("#familiesPrintHistoryBtn"); if(familiesPrint)familiesPrint.onclick=()=>printDigitalHistoryArchive(digitalHistoryMetaById(digitalHistorySelectedId));
 $$('[data-open-digital-history]').forEach(b=>b.onclick=()=>{digitalView="history";nav("digital");});$$("[data-new-product]").forEach(b=>b.onclick=()=>openProduct());
 $$("[data-view-product]").forEach(b=>b.onclick=()=>{let p=state.inventory.find(x=>x.id===b.dataset.viewProduct);if(p)openProductDetail(p)});
 $$("[data-view-movement]").forEach(b=>b.onclick=()=>{let m=state.movements.find(x=>x.id===b.dataset.viewMovement);if(m)openMovementDetail(m)});
 $$("[data-edit-movement]").forEach(b=>b.onclick=()=>{let m=state.movements.find(x=>x.id===b.dataset.editMovement);if(m)openQty(m)});
 $$('[data-delete-movement]').forEach(b=>b.onclick=async()=>{
  const m=state.movements.find(x=>x.id===b.dataset.deleteMovement);
  if(!m)return;
  if(!confirm(`¿Eliminar la salida del código ${m.code} por ${m.qty} unidad(es)?`))return;
  if(liveRealtimeReady()){
    try{
      const r=await cloudPostAction("live_movement_delete",{movementId:m.id});
      applyLiveMovementDelete(m.id,r.deletedAt||new Date().toISOString());
      if(r.product)applyLiveProductStock(r.product);
      saveLocal();render();toast("Salida eliminada en vivo e inventario restaurado.");
    }catch(err){toast(err?.message||"No se pudo eliminar la salida.");}
    return;
  }
  const p=itemForMovement(m);
  if(p){p.stock=(+p.stock||0)+(+m.qty||0);p.reorder=Math.max(0,(+p.max||0)-(+p.stock||0));p.stockUpdatedAt=new Date().toISOString();syncStockoutRecordsFromInventory("Movimiento eliminado");}
  state.movements=state.movements.filter(x=>x.id!==m.id);
  state.movementTombstones[m.id]=new Date().toISOString();
  save();render();toast("Salida eliminada e inventario restaurado.");
 });
 $$('[data-toggle-order-lock]').forEach(b=>{
  b.onclick=async e=>{
    e.preventDefault();
    e.stopPropagation();

    const m=state.movements.find(x=>x.id===b.dataset.toggleOrderLock);
    if(!m)return;

    const hasOrder=!!String(m.orderNumber||"").trim();
    if(!hasOrder){
      toast("Primero ingresa un N. de Orden.");
      return;
    }

    if(orderIsLocked(m)){
      m.orderLocked=false;
      if(liveRealtimeReady()){
        try{const r=await cloudPostAction("live_movement_patch",{movementId:m.id,patch:{orderNumber:m.orderNumber||"",orderLocked:false,status:m.status||"Descargado"}});if(r.movement)applyLiveMovementUpsert(r.movement);saveLocal();}
        catch(err){toast(err?.message||"No se pudo desbloquear.");return;}
      }else save();
      render();

      setTimeout(()=>{
        const input=$(`[data-order="${m.id}"]`);
        if(input){
          input.removeAttribute("readonly");
          input.classList.remove("order-locked");
          input.focus();
          input.select();
        }
      },30);

      toast("N. de Orden desbloqueado. Ya puedes editarlo.");
    }else{
      m.orderLocked=true;
      if(liveRealtimeReady()){
        try{const r=await cloudPostAction("live_movement_patch",{movementId:m.id,patch:{orderNumber:m.orderNumber||"",orderLocked:true,status:m.status||"Descargado"}});if(r.movement)applyLiveMovementUpsert(r.movement);saveLocal();}
        catch(err){toast(err?.message||"No se pudo bloquear.");return;}
      }else save();
      render();
      toast("N. de Orden bloqueado.");
    }
  };
 });
 $$("[data-order]").forEach(i=>{
  const movementId=i.dataset.order;
  const m=state.movements.find(x=>x.id===movementId);
  if(!m)return;

  const updateStatus=()=>{
    const hasOrder=!!String(m.orderNumber||"").trim();
    m.status=hasOrder?"Descargado":"PEND. DESCARGA";
    const e=$(`[data-mstatus="${m.id}"]`);
    if(e){
      e.textContent=m.status;
      e.classList.toggle("downloaded",hasOrder);
      e.classList.toggle("pending",!hasOrder);
    }
  };

  i.oninput=()=>{
    if(orderIsLocked(m)) return;
    m.orderNumber=i.value.trim();
    if(!m.orderNumber) m.orderLocked=false;
    updateStatus();
    saveLocal();
  };

  i.onblur=async()=>{
    if(orderIsLocked(m)) return;
    m.orderNumber=i.value.trim();
    if(m.orderNumber){
      m.orderLocked=true;
      updateStatus();
      if(liveRealtimeReady()){
        try{const r=await cloudPostAction("live_movement_patch",{movementId:m.id,patch:{orderNumber:m.orderNumber,orderLocked:true,status:m.status}});if(r.movement)applyLiveMovementUpsert(r.movement);saveLocal();}
        catch(err){toast(err?.message||"No se pudo guardar el N. de Orden.");return;}
      }else save();
      render();
      toast("N. de Orden guardado y bloqueado.");
    }else{
      m.orderLocked=false;
      updateStatus();
      if(liveRealtimeReady()){
        try{const r=await cloudPostAction("live_movement_patch",{movementId:m.id,patch:{orderNumber:"",orderLocked:false,status:m.status}});if(r.movement)applyLiveMovementUpsert(r.movement);saveLocal();}
        catch(err){toast(err?.message||"No se pudo actualizar el N. de Orden.");}
      }else save();
    }
  };

  i.onkeydown=e=>{
    if(e.key==="Enter" && !orderIsLocked(m)){
      e.preventDefault();
      i.blur();
    }
  };
});
 bindExit();bindCount();bindDigital();bindDifferenceActions();bindNewCodes();bindTools();bindConfig();
}
function bindExit(){let f=$("#exitForm");if(!f)return;let inp=$("#exitCode"),box=$("#suggestions"),info=$("#codeInfo");
 function infoUpdate(){let p=productByCode(inp.value);info.innerHTML=p?`<b>${esc(p.name)}</b> · Existencia: <b>${p.stock}</b>`:(inp.value.trim()?"Selecciona un código válido.":"Empieza a escribir para buscar.")}
 function show(){let q=inp.value.trim().toLowerCase();if(!q){box.hidden=true;return infoUpdate()}let a=state.inventory.filter(p=>p.code.toLowerCase().includes(q)||p.name.toLowerCase().includes(q)).slice(0,8);box.innerHTML=a.length?a.map(p=>`<button type="button" class="suggestion" data-code="${esc(p.code)}"><span><b>${esc(p.code)}</b><small>${esc(p.name)}</small></span><span class="stock">${p.stock}</span></button>`).join(""):`<div class="empty" style="padding:12px">Sin resultados</div>`;box.hidden=false;$$(".suggestion").forEach(b=>b.onpointerdown=e=>{e.preventDefault();inp.value=b.dataset.code;box.hidden=true;infoUpdate();$("#exitQty").focus()});infoUpdate()}
 inp.oninput=show;inp.onfocus=()=>inp.value.trim()&&show();inp.onblur=()=>setTimeout(()=>box.hidden=true,150);
 f.onsubmit=async e=>{
   e.preventDefault();
   const p=productByCode(inp.value),raw=$("#exitQty").value.trim(),q=+raw,tech=$("#exitTech").value,keep=$("#exitKeeper").value;
   if(!p)return toast("Selecciona un código válido.");if(raw===""||!Number.isInteger(q)||q<1)return toast("Ingresa una cantidad válida.");if(!tech)return toast("Selecciona un técnico.");if(!keep)return toast("Selecciona un bodeguero.");if(q>p.stock)return toast("No hay suficiente existencia.");
   const movement={id:uid(),date:new Date().toLocaleString("es-GT"),code:p.code,product:p.name,qty:q,technician:tech,keeper:keep,orderNumber:"",status:"PEND. DESCARGA",orderLocked:false};
   if(liveRealtimeReady()){
     try{
       const r=await cloudPostAction("live_movement_create",{movement});
       if(r.movement)applyLiveMovementUpsert(r.movement);
       if(r.product)applyLiveProductStock(r.product);
       saveLocal();toast("Salida registrada.");render();
     }catch(err){toast(err?.message||"No se pudo registrar la salida.");}
     return;
   }
   p.stock-=q;p.reorder=Math.max(0,(+p.max||0)-p.stock);p.stockUpdatedAt=new Date().toISOString();syncStockoutRecordsFromInventory("Control de Salida");movement.createdAt=new Date().toISOString();movement.updatedAt=movement.createdAt;state.movements.push(movement);save();toast("Salida registrada.");render();
 }
}
function closeWeeklyMenus(exceptId=""){
 ["filterMenu","fileMenu","printMenu","actionsMenu"].forEach(id=>{
   if(id!==exceptId){const el=$("#"+id);if(el)el.hidden=true}
 });
}
function weeklyCsvRows(items){
 return [["Código","Catálogo","Descripción","Familia","Existencia","Físico","Confirmado","Confirmado en","Confirmado por","Diferencia","Estado","Observación"],
 ...items.map(p=>{
   const c=weeklyCountState(p.id),diff=weeklyDiff(p,c.physical),st=weeklyStatus(p,c.physical);
   return [p.code,p.catalog||"",p.name,p.family||"",weeklyExpectedStock(p),c.physical===""?"":c.physical,c.confirmed?"Sí":"No",c.confirmedAt||"",c.confirmedBy||"",diff===""?"":diff,st.text,c.obs||""];
 })];
}
function exportWeeklyCSV(items=weeklyFilteredProducts(),filename="conteo-semanal.csv"){
 const rows=weeklyCsvRows(items);
 const data="\ufeff"+rows.map(r=>r.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\n");
 download(filename,data,"text/csv;charset=utf-8");toast("CSV generado.");
}
function downloadWeeklyTemplate(){
 const rows=[["Código"]];
 const data="\ufeff"+rows.map(r=>r.map(v=>`"${v}"`).join(",")).join("\n");
 download("plantilla-codigos-conteo.csv",data,"text/csv;charset=utf-8");toast("Plantilla descargada.");
}
function printWeekly(items,title){
 if(!items.length){toast("No hay productos para imprimir.");return}
 const rows=items.map(p=>{
   const c=weeklyCountState(p.id),diff=weeklyDiff(p,c.physical),st=weeklyStatus(p,c.physical);
   return `<tr><td>${esc(p.code)}</td><td>${esc(p.catalog||"")}</td><td>${esc(p.name)}</td><td>${esc(p.family||"")}</td><td>${weeklyExpectedStock(p)}</td><td>${c.physical===""?"":c.physical}</td><td>${c.confirmed?"✓":""}</td><td>${diff===""?"":(diff>0?"+":"")+diff}</td><td>${st.text}</td><td>${esc(c.obs||"")}</td></tr>`;
 }).join("");
 const w=window.open("","_blank","width=1100,height=800");
 if(!w){toast("El navegador bloqueó la ventana de impresión.");return}
 w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
 body{font-family:Arial,sans-serif;padding:24px;color:#111}h1{font-size:22px;margin:0 0 4px}.sub{color:#666;margin-bottom:18px}
 table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #bbb;padding:6px;text-align:left}th{background:#eee}
 @media print{button{display:none}body{padding:0}}</style></head><body>
 <h1>${esc(title)}</h1><div class="sub">${esc(state.weeklyMeta.label||"")} · Responsable: ${esc(state.weeklyMeta.responsible||"")}</div>
 <table><thead><tr><th>Código</th><th>Catálogo</th><th>Descripción</th><th>Familia</th><th>Exist.</th><th>Físico</th><th>✓</th><th>Dif.</th><th>Estado</th><th>Obs.</th></tr></thead><tbody>${rows}</tbody></table>
 <script>window.onload=()=>window.print()<\/script></body></html>`);
 w.document.close();
}
function addWeeklyProduct(product){
 if(!product)return false;
 if(!Array.isArray(state.weeklyMeta.productIds))state.weeklyMeta.productIds=[];
 if(!state.weeklyMeta.productIds.includes(product.id))state.weeklyMeta.productIds.push(product.id);
 if(!state.weeklyCounts[product.id])state.weeklyCounts[product.id]={physical:"",obs:"",updatedAt:"",confirmed:false,confirmedAt:"",confirmedBy:"",confirmedStock:null};
 return true;
}
function bindCount(){
 $$("[data-weekly-view]").forEach(btn=>{
   btn.onclick=()=>{
     weeklyView=btn.dataset.weeklyView==="history"?"history":"current";
     render();
   };
 });

 const histSelect=$("#weeklyHistorySelect");
 if(histSelect)histSelect.onchange=async()=>{
   weeklyHistorySelectedId=histSelect.value;
   weeklyHistoryLoadedArchive=null;
   render();
   await loadWeeklyArchive(weeklyHistorySelectedId,false);
   render();
 };
 const refreshHistory=$("#refreshWeeklyHistoryBtn");
 if(refreshHistory)refreshHistory.onclick=async()=>{
   await recoverWeeklyHistoryList(false);
   weeklyHistoryLoadedArchive=null;
   render();
   if(weeklyHistorySelectedId){
     await loadWeeklyArchive(weeklyHistorySelectedId,false);
     render();
   }
 };
 const printHistory=$("#printWeeklyHistoryBtn");
 if(printHistory)printHistory.onclick=()=>printWeeklyArchive(weeklyHistoryLoadedArchive);
 const exportHistory=$("#exportWeeklyHistoryBtn");
 if(exportHistory)exportHistory.onclick=()=>exportWeeklyArchiveCSV(weeklyHistoryLoadedArchive);

 if(weeklyView==="history"&&weeklyHistorySelectedId&&!weeklyHistoryLoadedArchive&&!weeklyHistoryLoading){
   setTimeout(async()=>{
     await loadWeeklyArchive(weeklyHistorySelectedId,true);
     if(weeklyView==="history")render();
   },30);
 }

 $$("[data-menu-btn]").forEach(btn=>{
   btn.onclick=e=>{
     e.stopPropagation();
     if(btn.disabled)return;
     const id=btn.dataset.menuBtn,menu=$("#"+id);
     if(!menu)return;
     const willOpen=menu.hidden;closeWeeklyMenus(id);menu.hidden=!willOpen;
   };
 });
 $$(".drop-menu").forEach(m=>m.onclick=e=>e.stopPropagation());

 const fam=$("#weeklyFilterFamily");
 if(fam)fam.onchange=()=>{state.weeklyMeta.filterFamily=fam.value;save();render()};
 const df=$("#weeklyDateFrom");
 if(df)df.onchange=()=>{state.weeklyMeta.dateFrom=df.value;save();render()};
 const dt=$("#weeklyDateTo");
 if(dt)dt.onchange=()=>{state.weeklyMeta.dateTo=dt.value;save();render()};
 const clearDates=$("#clearWeeklyDates");
 if(clearDates)clearDates.onclick=()=>{state.weeklyMeta.dateFrom="";state.weeklyMeta.dateTo="";save();render()};

 $$("[data-weekly-physical]").forEach(input=>{
   const productId=input.dataset.weeklyPhysical,product=[...state.inventory,...weeklyExtraProducts()].find(p=>p.id===productId);
   if(!product)return;
   const row=input.closest("tr");
   const refreshRowMark=()=>{
     if(!row)return;
     const raw=input.value.trim();
     row.classList.toggle("weekly-row-counted",raw!=="");
   };
   input.addEventListener("focus",()=>{if(row)row.classList.add("weekly-row-active")});
   input.addEventListener("blur",()=>{if(row)row.classList.remove("weekly-row-active")});
   const sync=()=>{
     if(!state.weeklyMeta.active||state.weeklyMeta.closed)return;
     const raw=input.value.trim();
     if(raw!==""&&(!/^\d+$/.test(raw)||Number(raw)<0)){toast("El conteo físico debe ser un número entero mayor o igual a 0.");return}
     if(!state.weeklyCounts[productId])state.weeklyCounts[productId]={physical:"",obs:"",updatedAt:"",confirmed:false,confirmedAt:"",confirmedBy:"",confirmedStock:null};
     state.weeklyCounts[productId].physical=raw===""?"":Number(raw);
     state.weeklyCounts[productId].updatedAt=new Date().toISOString();
     refreshRowMark();
     const diff=weeklyDiff(product,state.weeklyCounts[productId].physical),st=weeklyStatus(product,state.weeklyCounts[productId].physical);
     const diffEl=$(`[data-weekly-diff="${productId}"]`),statusEl=$(`[data-weekly-status="${productId}"]`);
     if(diffEl)diffEl.textContent=diff===""?"—":`${diff>0?"+":""}${diff}`;
     if(statusEl){statusEl.textContent=st.text;statusEl.className=`chip ${st.cls}`}
     persistWeeklyPatch(productId,{physical:state.weeklyCounts[productId].physical},180);
   };
   refreshRowMark();
   input.oninput=sync;input.onchange=sync;
 });
 $$("[data-weekly-confirm]").forEach(checkbox=>{
   const productId=checkbox.dataset.weeklyConfirm;
   const product=[...state.inventory,...weeklyExtraProducts()].find(p=>p.id===productId);
   if(!product)return;
   checkbox.onchange=()=>{
     if(!state.weeklyMeta.active||state.weeklyMeta.closed){checkbox.checked=!!weeklyCountState(productId).confirmed;return;}
     if(!state.weeklyCounts[productId])state.weeklyCounts[productId]={physical:"",obs:"",updatedAt:"",confirmed:false,confirmedAt:"",confirmedBy:"",confirmedStock:null};
     const c=state.weeklyCounts[productId];
     if(checkbox.checked){
       const physical=c.physical===0?0:(c.physical??"");
       if(physical===""){
         checkbox.checked=false;
         toast("Primero escribe el conteo Físico antes de confirmar la fila.");
         return;
       }
       const diff=weeklyDiff(product,physical);
       if(diff!==0){
         checkbox.checked=false;
         toast(`No se puede confirmar: esta fila tiene diferencia ${diff>0?"+":""}${diff}.`);
         return;
       }
       c.confirmed=true;
       c.confirmedAt=new Date().toISOString();
       c.confirmedBy=state.weeklyMeta.responsible||"";
       c.confirmedStock=Number(product.stock||0);
       c.updatedAt=new Date().toISOString();
       persistWeeklyPatch(productId,{
         confirmed:true,confirmedAt:c.confirmedAt,confirmedBy:c.confirmedBy,confirmedStock:c.confirmedStock
       },80);
       render();
       toast("Fila confirmada y bloqueada como Cuadreado.");
     }else{
       if(!confirm("¿Desbloquear esta fila para volver a editarla?")){
         checkbox.checked=true;
         return;
       }
       c.confirmed=false;
       c.confirmedAt="";
       c.confirmedBy="";
       c.confirmedStock=null;
       c.updatedAt=new Date().toISOString();
       persistWeeklyPatch(productId,{
         confirmed:false,confirmedAt:"",confirmedBy:"",confirmedStock:null
       },80);
       render();
       toast("Fila desbloqueada.");
     }
   };
 });

 $$("[data-weekly-extra-field]").forEach(input=>{
   input.oninput=()=>{
     if(!state.weeklyMeta.active||state.weeklyMeta.closed)return;
     const id=input.dataset.weeklyExtraId,field=input.dataset.weeklyExtraField;
     const item=(state.weeklyMeta.extraProducts||[]).find(p=>p.id===id);
     if(!item)return;
     if(field==="stock"){
       const raw=input.value.trim();
       item.stock=raw===""?0:Math.max(0,Number(raw)||0);
       const physical=weeklyCountState(id).physical;
       const virtual={...item,stock:item.stock};
       const diff=weeklyDiff(virtual,physical),st=weeklyStatus(virtual,physical);
       const diffEl=$(`[data-weekly-diff="${id}"]`),statusEl=$(`[data-weekly-status="${id}"]`);
       if(diffEl)diffEl.textContent=diff===""?"—":`${diff>0?"+":""}${diff}`;
       if(statusEl){statusEl.textContent=st.text;statusEl.className=`chip ${st.cls}`}
     }else{
       item[field]=input.value;
     }
     save();
   };
 });
 $$("[data-weekly-obs]").forEach(input=>{
   const productId=input.dataset.weeklyObs;
   input.oninput=()=>{
     if(!state.weeklyMeta.active||state.weeklyMeta.closed)return;
     if(!state.weeklyCounts[productId])state.weeklyCounts[productId]={physical:"",obs:"",updatedAt:"",confirmed:false,confirmedAt:"",confirmedBy:"",confirmedStock:null};
     state.weeklyCounts[productId].obs=input.value;
     state.weeklyCounts[productId].updatedAt=new Date().toISOString();
     persistWeeklyPatch(productId,{obs:state.weeklyCounts[productId].obs},260);
   };
 });

 const exportBtn=$("#exportWeeklyCsv");if(exportBtn)exportBtn.onclick=()=>exportWeeklyCSV();
 const templateBtn=$("#downloadWeeklyTemplate");if(templateBtn)templateBtn.onclick=downloadWeeklyTemplate;

 const importBtn=$("#importCodesBtn"),fileInput=$("#weeklyImportFile");
 if(importBtn&&fileInput)importBtn.onclick=()=>{if(state.weeklyMeta.active&&!state.weeklyMeta.closed)fileInput.click()};
 if(fileInput)fileInput.onchange=async()=>{
   const file=fileInput.files?.[0];
   if(!file)return;

   const text=(await file.text()).replace(/^\uFEFF/,"");
   const lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
   let codes=lines.map(line=>line.split(/[;,]/)[0].replace(/^"|"$/g,"").trim()).filter(Boolean);

   if(codes[0]&&codes[0].toLowerCase().replace(/\s/g,"").includes("código")){
     codes=codes.slice(1);
   }

   const uniqueCodes=[];
   const seenCodes=new Set();
   codes.forEach(code=>{
     const normalized=normalizeImportCode(code);
     if(!normalized||seenCodes.has(normalized))return;
     seenCodes.add(normalized);
     uniqueCodes.push(code);
   });

   const previousIds=[...(state.weeklyMeta.productIds||[])];
   const templateIds=[];
   const templateIdSet=new Set();

   let inventoryCount=0;
   let weeklyOnlyCount=0;

   uniqueCodes.forEach(code=>{
     let p=productByCode(code);

     if(!p){
       p=addWeeklyOnlyCode(code);
       weeklyOnlyCount++;
     }else{
       inventoryCount++;
     }
     if(!p)return;

     if(!state.weeklyCounts[p.id]){
       state.weeklyCounts[p.id]={physical:"",obs:"",updatedAt:"",confirmed:false,confirmedAt:"",confirmedBy:"",confirmedStock:null};
     }

     if(!templateIdSet.has(p.id)){
       templateIds.push(p.id);
       templateIdSet.add(p.id);
     }
   });

   // Any rows previously added manually but absent from this template
   // remain after the template, so existing work is not lost.
   const remainingIds=previousIds.filter(id=>!templateIdSet.has(id));

   // This is the official order of the weekly count.
   state.weeklyMeta.productIds=[...templateIds,...remainingIds];
   state.weeklyMeta.orderSource="template";
   state.weeklyMeta.templateCodeCount=templateIds.length;

   save();
   render();

   toast(
     `Orden de plantilla aplicado: ${templateIds.length} código(s) · `+
     `${inventoryCount} encontrados · ${weeklyOnlyCount} no registrados en su posición original.`
   );
 };
 $$("[data-print-mode]").forEach(btn=>btn.onclick=()=>{
   if(!state.weeklyMeta.active)return;
   const mode=btn.dataset.printMode;let items=[];
   if(mode==="all")items=weeklySelectedProducts();
   if(mode==="filtered")items=weeklyFilteredProducts();
   if(mode==="family")items=weeklySelectedProducts().filter(p=>p.family===state.weeklyMeta.filterFamily);
   if(mode==="pending")items=weeklySelectedProducts().filter(p=>weeklyCountState(p.id).physical==="");
   if(mode==="diffs")items=weeklySelectedProducts().filter(p=>{const c=weeklyCountState(p.id);return c.physical!==""&&weeklyDiff(p,c.physical)!==0});
   printWeekly(items,mode==="diffs"?"Conteo semanal - Solo diferencias":"Conteo semanal");
 });

 const create=$("#createWeekBtn");
 if(create)create.onclick=()=>{
   if(state.weeklyMeta.active)return;
   const suggestions=[...(state.settings.technicians||[]),...(state.settings.keepers||[])];
   const people=[...new Set(suggestions.filter(Boolean))];
   $("#cwResponsible").innerHTML=`<option value="">Selecciona responsable...</option>`+people.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join("");
   const range=mondaySaturdayRange(new Date());
   $("#cwLabel").value=range.label;
   $("#cwResponsible").value="";
   $("#createWeekDialog").showModal();
 };

 const next=$("#nextWeekBtn");
 if(next)next.onclick=async()=>{
   if(!state.weeklyMeta.active)return;
   if(!state.weeklyMeta.closed)return toast("Primero cierra la semana actual.");

   let archive=currentWeeklyArchiveMeta();
   if(!archive){
     const snapshot=buildWeeklyArchiveSnapshot();
     if(!snapshot)return toast("No hay productos para archivar.");
     addWeeklyArchiveLocal(snapshot);
     archive=currentWeeklyArchiveMeta();
   }

   if(archive?.needsSync||weeklyArchiveQueuedById(archive?.id)){
     if(!cloudConfig.enabled||!cloudReady()){
       return toast("No puedes crear la siguiente semana hasta respaldar la actual en Google Sheets.");
     }
     toast("Confirmando respaldo de la semana actual...");
     const ok=await syncWeeklyArchiveQueue(true);
     if(!ok){
       return toast("No se creó la siguiente semana: Google Sheets no confirmó el respaldo.");
     }
   }

   if(!confirm("¿Crear la siguiente semana? La semana cerrada ya quedó protegida en el historial."))return;
   const range=nextMondaySaturdayRange();
   state.weeklyCounts={};
   state.weeklyMeta={
     active:true,label:range.label,responsible:state.weeklyMeta.responsible||"",
     closed:false,filterFamily:"",dateFrom:"",dateTo:"",productIds:[],extraProducts:[],
     lastArchiveId:"",closedAt:"",orderSource:"",templateCodeCount:0
   };
   weeklyView="current";
   save();
   render();
   toast("Siguiente semana creada. La semana anterior permanece en Historial.");
 };
 const pull=$("#pullInventoryBtn");
 if(pull)pull.onclick=()=>{
   if(!state.weeklyMeta.active||state.weeklyMeta.closed)return;
   state.inventory.forEach(addWeeklyProduct);save();render();toast("Productos cargados desde Inventario.");
 };
 const add=$("#addWeeklyCodeBtn");
 if(add)add.onclick=()=>{
   if(!state.weeklyMeta.active||state.weeklyMeta.closed)return;
   const code=prompt("Escribe el código del producto:");if(!code)return;
   let p=productByCode(code),weeklyOnly=false;
   if(!p){p=addWeeklyOnlyCode(code);weeklyOnly=true}
   const exists=state.weeklyMeta.productIds.includes(p.id);addWeeklyProduct(p);save();render();
   toast(exists?"El código ya estaba en la semana.":weeklyOnly?"Código agregado solo a esta semana.":"Código agregado.");
 };
 const reset=$("#resetPhysicalBtn");
 if(reset)reset.onclick=()=>{
   if(!state.weeklyMeta.active||state.weeklyMeta.closed)return;
   if(!confirm("¿Reiniciar Físico y Observaciones de todos los productos de esta semana?"))return;
   const newCounts={};(state.weeklyMeta.productIds||[]).forEach(id=>newCounts[id]={physical:"",obs:"",updatedAt:"",confirmed:false,confirmedAt:"",confirmedBy:"",confirmedStock:null});
   state.weeklyCounts=newCounts;save();render();toast("Conteo físico reiniciado.");
 };
 const sheets=$("#saveSheetsBtn");
 if(sheets)sheets.onclick=async()=>{
   if(!state.weeklyMeta.active)return;
   if(!cloudConfig.enabled||!cloudReady())return toast("Conecta Google Sheets en Configuración.");
   clearTimeout(cloudSyncTimer);
   await syncToCloud(false);
 };
 const close=$("#closeWeekBtn");
 if(close)close.onclick=async()=>{
   if(!state.weeklyMeta.active||state.weeklyMeta.closed)return;
   const products=weeklySelectedProducts();
   if(!products.length)return toast("No hay productos en esta semana para archivar.");
   if(!confirm("¿Cerrar la semana y guardarla en el historial permanente?"))return;

   const archive=buildWeeklyArchiveSnapshot();
   if(!archive)return toast("No se pudo preparar el historial de la semana.");

   addWeeklyArchiveLocal(archive);
   state.weeklyMeta.closed=true;
   saveLocal();
   save();

   if(cloudConfig.enabled&&cloudReady()){
     toast("Semana cerrada. Respaldando historial en Google Sheets...");
     const ok=await syncWeeklyArchiveQueue(true);
     if(ok){
       save();
       render();
       toast("Semana cerrada y respaldada en Historial_Conteo_Semanal.");
     }else{
       render();
       toast("Semana cerrada en la PC. El respaldo quedó pendiente; no podrás crear la siguiente semana hasta confirmarlo.");
     }
   }else{
     render();
     toast("Semana cerrada en la PC. Conecta Google Sheets para respaldarla antes de crear la siguiente.");
   }
 };

 const reopen=$("#reopenWeekBtn");
 if(reopen)reopen.onclick=()=>{
   if(state.weeklyMeta.active&&state.weeklyMeta.closed){
     if(!confirm("¿Reabrir esta semana? El cierre anterior seguirá guardado en el Historial como una revisión."))return;
     state.weeklyMeta.closed=false;
     save();
     render();
     toast("Semana reabierta. Al volver a cerrar se guardará una nueva revisión.");
   }
 };
}function csv(){let rows=[["Código","Catálogo","Descripción","Familia","Existencia","Mínimo","Máximo","Ubicación","Reposición","Estado"],...orderedProducts(state.inventory).map(p=>[p.code,p.catalog,p.name,p.family,p.stock,p.min,p.max,p.location,p.reorder,p.stock===0?"Sin existencia":p.stock<=p.min?"Stock bajo":"Disponible"])];download("inventario.csv","\ufeff"+rows.map(r=>r.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\n"),"text/csv")}
function backup(){download("mi-bodega-backup.json",JSON.stringify(state,null,2),"application/json")}
function download(n,d,t){let u=URL.createObjectURL(new Blob([d],{type:t})),a=document.createElement("a");a.href=u;a.download=n;a.click();URL.revokeObjectURL(u)}
function digitalResponsibleOptions(){
 const people=[...(state.settings.technicians||[]),...(state.settings.keepers||[])];
 return [...new Set(people.filter(Boolean))].sort((a,b)=>a.localeCompare(b,"es"));
}
function openDigitalResponsibleDialog(){
 const sel=$("#digitalResponsibleSelect");
 if(sel){
   sel.innerHTML=`<option value="">Selecciona responsable...</option>`+
     digitalResponsibleOptions().map(name=>`<option value="${esc(name)}" ${state.digitalFilter.responsible===name?"selected":""}>${esc(name)}</option>`).join("");
 }
 const custom=$("#digitalResponsibleCustom");
 if(custom)custom.value="";
 $("#digitalResponsibleDialog").showModal();
}
function reviewHistoryDifference(historyId){
 const rec=(state.differenceHistory||[]).find(r=>r.id===historyId);
 if(!rec)return toast("No se encontró la diferencia.");
 if(!differenceRecordOpen(rec))return toast("Esta diferencia ya está resuelta.");

 const p=currentProductForDifference(rec);
 if(!p)return toast("El producto ya no está disponible en el Inventario.");

 const responsible=rec.responsible||state.digitalFilter.responsible||"";

 if(digitalFamilyClosed(p.family)){
   if(!confirm(`La familia ${p.family} está cerrada. ¿Reabrirla para revisar esta diferencia?`))return;
   reopenDigitalFamily(p.family,responsible);
 }else{
   state.digitalFilter.responsible=responsible;
   state.digitalFilter.family=p.family||rec.family||"";
   state.digitalFilter.search="";
 }

 state.digitalCounts[p.id]={
   physical:"",
   obs:rec.obs||"",
   detectedAt:"",
   responsible,
   historyId:rec.id
 };

 save();
 state.page="digital";
 render();

 setTimeout(()=>{
   const input=$(`[data-digital-physical="${p.id}"]`);
   if(input){
     input.scrollIntoView({behavior:"smooth",block:"center"});
     input.focus();
   }
 },80);

 toast("Diferencia cargada para revisión. Haz un conteo físico nuevo.");
}
function reviewDigitalDifference(productId){
 const p=state.inventory.find(x=>x.id===productId);
 if(!p)return toast("Producto no encontrado.");
 const c=digitalCountState(productId);
 const responsible=c.responsible||digitalFamilySession(p.family)?.responsible||state.digitalFilter.responsible||"";

 if(digitalFamilyClosed(p.family)){
   if(!confirm(`La familia ${p.family} está cerrada. ¿Reabrirla para revisar el conteo?`))return;
   reopenDigitalFamily(p.family,responsible);
 }else{
   state.digitalFilter.responsible=responsible;
   state.digitalFilter.family=p.family||"";
   state.digitalFilter.search="";
   save();
 }

 state.page="digital";
 render();
 setTimeout(()=>{
   const input=$(`[data-digital-physical="${productId}"]`);
   if(input){
     input.scrollIntoView({behavior:"smooth",block:"center"});
     input.focus();
     input.select();
   }
 },80);
 toast("Revisa el conteo físico y corrígelo si es necesario.");
}
function adjustInventoryFromDifference(productId){
 const p=state.inventory.find(x=>x.id===productId);
 if(!p)return toast("Producto no encontrado.");
 const c=digitalCountState(productId);
 if(c.physical===""||c.physical===null||c.physical===undefined)return toast("No hay conteo físico para ajustar.");

 const physical=Number(c.physical);
 const before=Number(p.stock||0);
 const diff=physical-before;
 if(diff===0)return toast("Este producto ya está cuadreado.");

 if(!confirm(`¿Ajustar el inventario del código ${p.code} de ${before} a ${physical}?`))return;

 // Asegurar que la diferencia quede archivada antes de ajustar.
 const rec=syncDifferenceHistoryFromDigital(p);

 if(!Array.isArray(state.digitalAdjustments))state.digitalAdjustments=[];
 state.digitalAdjustments.push({
   id:uid(),
   date:new Date().toISOString(),
   code:p.code,
   productId:p.id,
   family:p.family||"",
   before,
   physical,
   difference:diff,
   responsible:c.responsible||state.digitalFilter.responsible||""
 });

 p.stock=physical;
 p.reorder=Math.max(0,(+p.max||0)-physical);
 syncStockoutRecordsFromInventory("Ajuste Inventario Digital");

 if(rec)resolveDifferenceRecord(rec,"Ajuste de inventario");
 if(state.digitalCounts[p.id]){
   state.digitalCounts[p.id].detectedAt="";
 }

 save();
 render();
 toast("Inventario general ajustado y diferencia marcada como resuelta.");
}
function bindDifferenceActions(){
 $$("[data-difference-view]").forEach(btn=>{
   btn.onclick=()=>{
     differenceView=btn.dataset.differenceView==="history"?"history":"open";
     render();
   };
 });

 $$("[data-review-history]").forEach(btn=>{
   btn.onclick=()=>reviewHistoryDifference(btn.dataset.reviewHistory);
 });

 $$("[data-review-difference]").forEach(btn=>{
   btn.onclick=()=>reviewDigitalDifference(btn.dataset.reviewDifference);
 });

 $$("[data-adjust-difference]").forEach(btn=>{
   btn.onclick=()=>adjustInventoryFromDifference(btn.dataset.adjustDifference);
 });
}
function digitalCalculatorFormat(n){
 if(!Number.isFinite(n))return "Error";
 const rounded=Math.round((n+Number.EPSILON)*100000000)/100000000;
 return String(rounded);
}
function digitalCalculatorCompute(a,b,op){
 if(op==="+")return a+b;
 if(op==="-")return a-b;
 if(op==="*")return a*b;
 if(op==="/")return b===0?NaN:a/b;
 return b;
}
function updateDigitalCalculatorUI(){
 const display=$("#digitalCalculatorDisplay");
 if(display)display.textContent=digitalCalcDisplay;
 const target=$("#digitalCalculatorTarget");
 const p=state.inventory.find(x=>x.id===digitalCalcTargetId);
 if(target)target.textContent=p?`Resultado → Físico de ${p.code}${p.name?` · ${p.name}`:""}`:"Calculadora libre. Abre 🧮 desde una fila para enviar el resultado a Físico.";
 const exp=$("#digitalCalculatorExpression");
 if(exp){
   const opLabel=digitalCalcOp==="*"?"×":digitalCalcOp==="/"?"÷":digitalCalcOp||"";
   exp.textContent=digitalCalcStored!==null&&digitalCalcOp?`${digitalCalculatorFormat(digitalCalcStored)} ${opLabel} …`:"Listo para calcular";
 }
 const use=$("#digitalCalculatorUse");
 if(use)use.disabled=!p;
}
function resetDigitalCalculator(seed="0"){
 digitalCalcDisplay=String(seed===""?"0":seed);
 digitalCalcStored=null;
 digitalCalcOp=null;
 digitalCalcWaiting=false;
 updateDigitalCalculatorUI();
}
function openDigitalCalculator(productId=""){
 if(productId)digitalCalcTargetId=productId;
 const p=state.inventory.find(x=>x.id===digitalCalcTargetId);
 const c=p?digitalCountState(p.id):null;
 resetDigitalCalculator(c&&c.physical!==""?c.physical:"0");
 const dlg=$("#digitalCalculatorDialog");
 if(!dlg)return;
 if(typeof dlg.showModal==="function")dlg.showModal(); else dlg.setAttribute("open","");
 dlg.setAttribute("tabindex","-1");
 try{dlg.focus({preventScroll:true});}catch(_){try{dlg.focus();}catch(__){}}
 updateDigitalCalculatorUI();
}
function closeDigitalCalculator(){
 const dlg=$("#digitalCalculatorDialog");
 if(!dlg)return;
 if(typeof dlg.close==="function")dlg.close(); else dlg.removeAttribute("open");
}
function digitalCalculatorKeyboard(e){
 const dlg=$("#digitalCalculatorDialog");
 if(!dlg||!dlg.open)return;
 const key=String(e.key||"");
 let handled=true;
 if(/^[0-9]$/.test(key)) digitalCalculatorDigit(key);
 else if(key==="+") digitalCalculatorChooseOp("+");
 else if(key==="-") digitalCalculatorChooseOp("-");
 else if(key==="*"||key==="x"||key==="X") digitalCalculatorChooseOp("*");
 else if(key==="/") digitalCalculatorChooseOp("/");
 else if(key==="Enter"||key==="=") digitalCalculatorEquals();
 else if(key==="Backspace") digitalCalculatorBackspace();
 else if(key==="Delete"||key==="c"||key==="C") resetDigitalCalculator();
 else if(key==="Escape") closeDigitalCalculator();
 else handled=false;
 if(handled){
   e.preventDefault();
   e.stopPropagation();
 }
}
function digitalCalculatorDigit(digit){
 if(digitalCalcDisplay==="Error"||digitalCalcWaiting){digitalCalcDisplay="0";digitalCalcWaiting=false;}
 const clean=String(digit);
 if(digitalCalcDisplay==="0")digitalCalcDisplay=clean==="00"?"0":clean;
 else if(digitalCalcDisplay.replace(/[^0-9]/g,"").length<12)digitalCalcDisplay+=clean;
 updateDigitalCalculatorUI();
}
function digitalCalculatorChooseOp(op){
 const current=Number(digitalCalcDisplay);
 if(!Number.isFinite(current))return resetDigitalCalculator();
 if(digitalCalcStored!==null&&digitalCalcOp&&!digitalCalcWaiting){
   const result=digitalCalculatorCompute(digitalCalcStored,current,digitalCalcOp);
   if(!Number.isFinite(result)){digitalCalcDisplay="Error";digitalCalcStored=null;digitalCalcOp=null;digitalCalcWaiting=true;return updateDigitalCalculatorUI();}
   digitalCalcDisplay=digitalCalculatorFormat(result);
   digitalCalcStored=result;
 }else digitalCalcStored=current;
 digitalCalcOp=op;
 digitalCalcWaiting=true;
 updateDigitalCalculatorUI();
}
function digitalCalculatorEquals(){
 if(digitalCalcStored===null||!digitalCalcOp)return;
 const current=Number(digitalCalcDisplay);
 const result=digitalCalculatorCompute(digitalCalcStored,current,digitalCalcOp);
 if(!Number.isFinite(result)){digitalCalcDisplay="Error";} else digitalCalcDisplay=digitalCalculatorFormat(result);
 digitalCalcStored=null;
 digitalCalcOp=null;
 digitalCalcWaiting=true;
 updateDigitalCalculatorUI();
}
function digitalCalculatorBackspace(){
 if(digitalCalcDisplay==="Error"||digitalCalcWaiting)return resetDigitalCalculator();
 digitalCalcDisplay=digitalCalcDisplay.length>1?digitalCalcDisplay.slice(0,-1):"0";
 updateDigitalCalculatorUI();
}
function useDigitalCalculatorResult(){
 const p=state.inventory.find(x=>x.id===digitalCalcTargetId);
 if(!p)return toast("Abre la calculadora desde la fila del producto que estás contando.");
 const value=Number(digitalCalcDisplay);
 if(!Number.isFinite(value)||value<0||!Number.isInteger(value))return toast("El resultado para Físico debe ser un número entero mayor o igual a 0.");
 const input=$(`[data-digital-physical="${CSS.escape(p.id)}"]`);
 if(!input)return toast("La fila ya no está visible. Busca nuevamente el producto.");
 input.value=String(value);
 input.dispatchEvent(new Event("input",{bubbles:true}));
 input.focus();
 closeDigitalCalculator();
 toast(`Físico de ${p.code}: ${value}`);
}
function bindDigitalCalculator(){
 const top=$("#digitalCalculatorBtn");
 if(top)top.onclick=()=>openDigitalCalculator(digitalCalcTargetId||"");
 $$('[data-digital-calc]').forEach(btn=>{
   btn.onclick=()=>openDigitalCalculator(btn.dataset.digitalCalc||"");
 });
 const dlg=$("#digitalCalculatorDialog");
 const close=$("#digitalCalculatorClose");
 if(close)close.onclick=()=>closeDigitalCalculator();
 if(dlg){
   dlg.onclick=e=>{if(e.target===dlg)closeDigitalCalculator();};
   dlg.onkeydown=digitalCalculatorKeyboard;
 }
 $$('[data-calc-digit]').forEach(btn=>btn.onclick=()=>digitalCalculatorDigit(btn.dataset.calcDigit||"0"));
 $$('[data-calc-op]').forEach(btn=>btn.onclick=()=>digitalCalculatorChooseOp(btn.dataset.calcOp||"+"));
 $$('[data-calc-action]').forEach(btn=>{
   btn.onclick=()=>{
     const a=btn.dataset.calcAction;
     if(a==="clear")resetDigitalCalculator();
     else if(a==="backspace")digitalCalculatorBackspace();
     else if(a==="equals")digitalCalculatorEquals();
   };
 });
 const reset=$("#digitalCalculatorReset");
 if(reset)reset.onclick=()=>resetDigitalCalculator();
 const use=$("#digitalCalculatorUse");
 if(use)use.onclick=()=>useDigitalCalculatorResult();
 updateDigitalCalculatorUI();
}
function bindDigital(){
 $$('[data-digital-view]').forEach(btn=>btn.onclick=async()=>{digitalView=btn.dataset.digitalView==="history"?"history":"current";digitalHistoryLoadedArchive=null;render();if(digitalView==="history"&&digitalHistorySelectedId)await ensureDigitalArchiveLoaded(digitalHistorySelectedId,true);});
 const histSelect=$("#digitalHistorySelect");
 if(histSelect)histSelect.onchange=async()=>{digitalHistorySelectedId=histSelect.value;digitalHistoryLoadedArchive=null;render();await ensureDigitalArchiveLoaded(digitalHistorySelectedId,true);};
 const printHist=$("#printDigitalHistoryBtn");
 if(printHist)printHist.onclick=()=>printDigitalHistoryArchive(digitalHistoryMetaById(digitalHistorySelectedId));
 if(digitalView==="history")return;
 const responsibleBtn=$("#digitalResponsibleBtn");
 if(responsibleBtn)responsibleBtn.onclick=()=>openDigitalResponsibleDialog();

 const closeFamilyBtn=$("#closeDigitalFamilyBtn");
 if(closeFamilyBtn)closeFamilyBtn.onclick=()=>closeDigitalFamily();

 const printFamilyBtn=$("#printDigitalFamilyBtn");
 if(printFamilyBtn)printFamilyBtn.onclick=()=>printDigitalFamilySheet();

 bindDigitalCalculator();

 const family=$("#digitalFamilySelect");
 if(family)family.onchange=()=>{
   if(!state.digitalFilter.responsible){
     family.value="";
     toast("Primero asigna el responsable del conteo físico.");
     openDigitalResponsibleDialog();
     return;
   }
   state.digitalFilter.family=family.value;
   state.digitalFilter.search="";
   save();
   render();
   if(digitalFamilyClosed(family.value))toast("Esta familia está cerrada. Usa Diferencias → Revisar para reabrirla.");
 };

 const search=$("#digitalSearchInput");
 if(search)search.oninput=()=>{
   state.digitalFilter.search=search.value;
   save();
   const items=digitalFilteredProducts();
   const tbody=$(".digital-table tbody");
   if(tbody)tbody.innerHTML=digitalRows(items);
   bindDigitalInlineOnly();
 };

 const filterBtn=$("#digitalConditionBtn"),panel=$("#digitalConditionMenu");
 if(filterBtn&&panel){
   filterBtn.onclick=e=>{
     e.stopPropagation();
     if(filterBtn.disabled)return;
     const willOpen=panel.hidden;
     closeWeeklyMenus();
     panel.hidden=!willOpen;
   };
   panel.onclick=e=>e.stopPropagation();
 }
 const type=$("#digitalConditionType"),v2wrap=$("#digitalValue2Wrap");
 const syncV2=()=>{if(v2wrap)v2wrap.style.display=type?.value==="between"?"flex":"none"};
 if(type){type.onchange=syncV2;syncV2()}

 const apply=$("#applyDigitalCondition");
 if(apply)apply.onclick=()=>{
   state.digitalFilter.field=$("#digitalConditionField").value;
   state.digitalFilter.condition=$("#digitalConditionType").value;
   state.digitalFilter.value1=$("#digitalConditionValue1").value;
   state.digitalFilter.value2=$("#digitalConditionValue2").value;
   save();render();
 };
 const clear=$("#clearDigitalCondition");
 if(clear)clear.onclick=()=>{
   state.digitalFilter.field="name";
   state.digitalFilter.condition="none";
   state.digitalFilter.value1="";
   state.digitalFilter.value2="";
   save();render();
 };

 bindDigitalInlineOnly();
}
function bindDigitalInlineOnly(){
 $$('[data-digital-calc]').forEach(btn=>{
   btn.onclick=()=>openDigitalCalculator(btn.dataset.digitalCalc||"");
 });
 $$("[data-digital-physical]").forEach(input=>{
   const id=input.dataset.digitalPhysical,p=state.inventory.find(x=>x.id===id);
   if(!p)return;
   const row=input.closest("tr");
   const syncRowVisual=()=>{
     if(!row)return;
     const hasPhysical=String(input.value||"").trim()!=="";
     row.classList.toggle("digital-row-counted",hasPhysical);
   };
   input.onfocus=()=>{
     digitalCalcTargetId=id;
     if(row)row.classList.add("digital-row-active");
   };
   input.onblur=()=>{
     if(row)row.classList.remove("digital-row-active");
     syncRowVisual();
   };
   input.oninput=()=>{
     syncRowVisual();
     if(digitalFamilyClosed(state.digitalFilter.family))return;
     const raw=input.value.trim();
     if(raw!==""&&(!/^\d+$/.test(raw)||Number(raw)<0)){toast("El físico debe ser un número entero mayor o igual a 0.");return}
     if(!state.digitalCounts[id])state.digitalCounts[id]={physical:"",obs:"",detectedAt:"",responsible:state.digitalFilter.responsible||""};
     state.digitalCounts[id].physical=raw===""?"":Number(raw);
     state.digitalCounts[id].responsible=state.digitalFilter.responsible||state.digitalCounts[id].responsible||"";
     state.digitalCounts[id].updatedAt=new Date().toISOString();
     if(raw!=="")state.digitalCounts[id].expectedAtCount=Number(p.stock||0);

     const physical=state.digitalCounts[id].physical;
     const diff=digitalDiff(p,physical);

     if(physical!==""&&diff!==0){
       if(!state.digitalCounts[id].detectedAt){
         state.digitalCounts[id].detectedAt=new Date().toISOString();
       }
     }else{
       state.digitalCounts[id].detectedAt="";
     }

     syncDifferenceHistoryFromDigital(p);

     const diffEl=$(`[data-digital-diff="${id}"]`);
     if(diffEl){
       const diffText=diff===""?"—":`${Number(diff)>0?"+":""}${Number(diff)}`;
       const diffCls=diff===""?"is-empty":Number(diff)===0?"is-zero":Number(diff)>0?"is-positive":"is-negative";
       diffEl.textContent=diffText;
       diffEl.className=`digital-diff-value ${diffCls}`;
     }
     const st=digitalStatus(p,physical);
     const statusEl=$(`[data-digital-status="${id}"]`);
     if(statusEl){statusEl.textContent=st.text;statusEl.className=`chip ${st.cls}`}
     saveLocal();
     save();
   };
 });
 $$("[data-digital-obs]").forEach(input=>{
   const id=input.dataset.digitalObs;
   input.oninput=()=>{
     if(digitalFamilyClosed(state.digitalFilter.family))return;
     if(!state.digitalCounts[id])state.digitalCounts[id]={physical:"",obs:"",detectedAt:"",responsible:state.digitalFilter.responsible||""};
     state.digitalCounts[id].obs=input.value;
     state.digitalCounts[id].updatedAt=new Date().toISOString();
     const p=state.inventory.find(x=>x.id===id);
     if(p)syncDifferenceHistoryFromDigital(p);
     saveLocal();
     save();
   };
 });
 $$("[data-view-product]").forEach(b=>b.onclick=()=>{let p=state.inventory.find(x=>x.id===b.dataset.viewProduct);if(p)openProductDetail(p)});
}
function normalizeImportCode(v){
 return String(v||"").trim().toUpperCase();
}
function parseInventoryTxt(text){
 const byCode=new Map();
 let parsedLines=0,skippedLines=0;

 String(text||"").split(/\r?\n/).forEach(line=>{
   const raw=String(line||"").replace(/\u00A0/g," ").trim();
   if(!raw)return;

   // Reporte IRG077:
   // TI MA PR Artículo [número interno de 6 dígitos] Descripción Existencia
   const m=raw.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d{6})\s+(.+?)\s+(-?\d+(?:[.,]\d+)?)$/);
   if(!m){skippedLines++;return}

   const [,ti,ma,pr,article,internalNumber,description,stockRaw]=m;
   const code=normalizeImportCode(article);
   if(!code){skippedLines++;return}

   const stock=Number(String(stockRaw).replace(",","."));
   if(!Number.isFinite(stock)){skippedLines++;return}
   parsedLines++;

   const row={
     ti:String(ti||"").trim(),
     ma:String(ma||"").trim(),
     family:String(pr||"").trim().toUpperCase(),
     code,
     internalNumber:String(internalNumber||"").trim(),
     name:String(description||"").replace(/\s+/g," ").trim(),
     stock
   };

   if(byCode.has(code)){
     byCode.get(code).stock=Number(byCode.get(code).stock||0)+stock;
   }else{
     byCode.set(code,row);
   }
 });

 return {
   items:[...byCode.values()],
   parsedLines,
   duplicates:Math.max(0,parsedLines-byCode.size),
   skippedLines
 };
}
async function readLegacyTxtFile(file){
 const buffer=await file.arrayBuffer();
 try{
   return new TextDecoder("windows-1252").decode(buffer);
 }catch(err){
   return new TextDecoder("utf-8").decode(buffer);
 }
}
async function getBaseProductsFromSheets(){
 if(!cloudConfig.enabled||!cloudReady()){
   throw new Error("Google Sheets no está conectado.");
 }

 let r;
 try{
   r=await cloudJsonp("base_products");
 }catch(err){
   throw new Error("No se pudo consultar BASE_PRODUCTOS. Revisa que la Web App de Apps Script esté actualizada.");
 }

 if(!r||!r.ok){
   const msg=String(r?.error||"");
   if(/acción no válida|accion no valida/i.test(msg)){
     throw new Error("Tu Apps Script todavía es V26. Actualiza la implementación a la NUEVA VERSIÓN V27 y conserva la misma URL /exec.");
   }
   throw new Error(msg||"No se pudo leer BASE_PRODUCTOS.");
 }

 const list=Array.isArray(r.products)?r.products:[];
 const map=new Map();
 list.forEach(p=>{
   const code=normalizeImportCode(p.code);
   if(code)map.set(code,{
     code,
     catalog:catalogText(p.catalog).trim(),
     description:String(p.description||"").trim(),
     family:String(p.family||"").trim(),
     min:Number(p.min||0)||0,
     max:Number(p.max||0)||0,
     reorder:Number(p.reorder||0)||0
   });
 });
 return map;
}
function buildImportedInventory(reportItems,baseMap){
 const oldInventory=orderedProducts(state.inventory);
 const oldByCode=new Map(oldInventory.map(p=>[normalizeImportCode(p.code),p]));
 const oldPending=new Map((state.pendingBaseProducts||[]).map(p=>[normalizeImportCode(p.code),p]));
 const reportCodes=new Set(reportItems.map(r=>normalizeImportCode(r.code)));
 let matched=0,missing=0,disappeared=0;
 const newPending=[];

 // El índice del TXT se convierte en el ORDEN MAESTRO.
 const products=reportItems.map((row,index)=>{
   const base=baseMap.get(row.code);
   const old=oldByCode.get(row.code);
   const previous=oldPending.get(row.code);
   const importOrder=index+1;

   if(base)matched++; else missing++;

   if(!base){
     newPending.push({
       code:row.code,
       catalog:catalogText(previous?.catalog).trim(),
       description:String(previous?.description||row.name||"").trim(),
       family:String(previous?.family||row.family||"").trim(),
       min:Number(previous?.min||old?.min||0)||0,
       max:Number(previous?.max||old?.max||0)||0,
       status:"Pendiente",
       importOrder
     });
   }

   const min=base?Number(base.min||0):(Number(previous?.min||old?.min||0)||0);
   const max=base?Number(base.max||0):(Number(previous?.max||old?.max||0)||0);
   const stock=Number(row.stock||0);

   return {
     id:old?.id||uid(),
     code:row.code,
     catalog:catalogText(base?.catalog??previous?.catalog??old?.catalog??""),
     name:row.name,
     family:row.family,
     stock,
     min,
     max,
     location:old?.location||"",
     reorder:Math.max(0,max-stock),
     importOrder
   };
 });

 // Los que desaparecieron del reporte pasan a Existencia 0.
 // Se colocan DESPUÉS del reporte actual, conservando entre ellos
 // el mismo orden que tenían previamente.
 let historicalOrder=reportItems.length+1;
 oldInventory.forEach(old=>{
   const code=normalizeImportCode(old.code);
   if(!code||reportCodes.has(code))return;

   const wasStock=Number(old.stock||0);
   if(wasStock>0)disappeared++;

   products.push({
     ...old,
     stock:0,
     reorder:Math.max(0,Number(old.max||0)),
     stockoutSource:"Importación TXT",
     importOrder:historicalOrder++
   });
 });

 // Mantener pendientes de BASE_PRODUCTOS en el orden maestro.
 const pendingCodes=new Set(newPending.map(p=>normalizeImportCode(p.code)));
 (state.pendingBaseProducts||[]).forEach(p=>{
   const code=normalizeImportCode(p.code);
   const inventoryProduct=products.find(x=>normalizeImportCode(x.code)===code);
   if(code&&!pendingCodes.has(code)&&!baseMap.has(code)){
     newPending.push({
       ...p,
       status:"Pendiente",
       importOrder:inventoryProduct?.importOrder??p.importOrder??999999999
     });
     pendingCodes.add(code);
   }
 });

 newPending.sort((a,b)=>normalizeMasterOrderValue(a.importOrder)-normalizeMasterOrderValue(b.importOrder));

 return {
   products:orderedProducts(products),
   matched,
   missing,
   newPending,
   disappeared,
   reportCount:reportItems.length
 };
}
async function importInventoryTxt(file){
 if(!file)return;
 if(!cloudConfig.enabled||!cloudReady()){
   toast("Primero conecta Google Sheets en Configuración.");
   return;
 }

 try{
   toast("Leyendo archivo de inventario...");
   const text=await readLegacyTxtFile(file);
   const parsed=parseInventoryTxt(text);

   if(!parsed.items.length){
     toast("No se encontraron productos válidos en el archivo.");
     return;
   }

   toast("Consultando BASE_PRODUCTOS en Google Sheets...");
   const baseMap=await getBaseProductsFromSheets();
   const built=buildImportedInventory(parsed.items,baseMap);

   const msg=
     `El reporte trae ${built.reportCount} producto(s) con existencia.\n\n`+
     `${built.matched} encontrados en BASE_PRODUCTOS.\n`+
     `${built.missing} sin coincidencia en BASE_PRODUCTOS.\n`+
     `${built.disappeared} código(s) que estaban en el inventario anterior ya no aparecen.\n`+
     `Esos códigos se conservarán con Existencia 0 y pasarán a Sin Existencia con fecha y hora.\n`+
     `El orden exacto del archivo será el orden maestro de todo el sistema.\n`+
     `${parsed.duplicates} línea(s) duplicada(s) agrupada(s).\n\n`+
     `¿Actualizar el Inventario con este reporte?`;

   if(!confirm(msg))return;

   // Antes de cambiar existencias, conservar y RESPALDAR todas las diferencias.
   const archivedDifferences=archiveCurrentDigitalDifferences();
   saveLocal();

   const pendingBackup=pendingDifferenceSyncCount();
   if(pendingBackup>0){
     toast(`Respaldando ${pendingBackup} diferencia(s) en Google Sheets...`);
     const backupOk=await syncDifferenceHistoryQueue(true);
     if(!backupOk){
       toast("IMPORTACIÓN CANCELADA: primero deben quedar respaldadas las diferencias en Google Sheets.");
       return;
     }
   }

   // V80: antes de reemplazar existencias, archivar el conteo digital actual.
   // Si una importación anterior se canceló y el mismo conteo ya quedó protegido,
   // no se crea un duplicado: se reutiliza el respaldo por checksum + versión.
   const archivedDigital=archiveAllCurrentDigitalCounts("Importación de inventario",true);
   saveLocal();
   const pendingDigital=pendingDigitalArchiveCount();
   if(pendingDigital>0){
     toast(`Respaldando ${pendingDigital} archivo(s) de Inventario Digital...`);
     const digitalBackupOk=await syncDigitalArchiveQueue(true);
     if(!digitalBackupOk){
       toast("IMPORTACIÓN CANCELADA: primero debe quedar respaldado el Historial de Inventario Digital en Google Sheets.");
       return;
     }
   }
   if(archivedDigital.total>0&&archivedDigital.created===0&&archivedDigital.alreadyProtected>0){
     console.info(`V80: ${archivedDigital.alreadyProtected} familia(s) ya tenían respaldo equivalente; no se duplicó el historial.`);
   }

   const importNow=new Date().toISOString();
   state.inventory=built.products.map(p=>({...p,stockUpdatedAt:importNow}));
   state.inventoryVersionAt=importNow;
   state.pendingBaseProducts=built.newPending;
   syncStockoutRecordsFromInventory("Importación TXT");

   // El conteo digital actual inicia limpio, pero el historial NO se borra.
   state.digitalResetAt=importNow;
   state.digitalCounts={};
   state.digitalFilter={
     family:"",
     search:"",
     field:"name",
     condition:"none",
     value1:"",
     value2:"",
     responsible:""
   };
   state.digitalClosedFamilies={};

   save();

   if(cloudConfig.enabled&&cloudReady()){
     clearTimeout(cloudSyncTimer);
     await syncToCloud(false);
   }

   render();
   toast(`Inventario actualizado · ${archivedDigitalFamilies} familia(s) de Inventario Digital archivada(s) · ${archivedDifferences} diferencia(s) conservada(s) · ${built.disappeared} nuevo(s) Sin Existencia.`);
 }catch(err){
   console.error(err);
   toast(err?.message||"No se pudo importar el inventario.");
 }
}
function updatePendingInventory(index){
 const p=state.pendingBaseProducts[index];
 if(!p)return;
 const inv=state.inventory.find(x=>normalizeImportCode(x.code)===normalizeImportCode(p.code));
 if(inv){
   inv.catalog=String(p.catalog||"").trim();
   inv.name=String(p.description||inv.name||"").trim();
   inv.family=String(p.family||inv.family||"").trim();
   inv.min=Number(p.min||0)||0;
   inv.max=Number(p.max||0)||0;
   inv.reorder=Math.max(0,inv.max-Number(inv.stock||0));
 }
}
function pendingBaseComplete(p){
 return !!(
   String(p?.code||"").trim() &&
   String(p?.description||"").trim() &&
   String(p?.family||"").trim() &&
   Number.isFinite(Number(p?.min)) &&
   Number.isFinite(Number(p?.max)) &&
   Number(p.max)>=Number(p.min)
 );
}
let baseProductQueueTimer=null,baseProductQueueSyncing=false;
function enqueueBaseProductSync(product){
 const p={
   code:String(product.code||"").trim(),
   catalog:catalogText(product.catalog).trim(),
   description:String(product.description||"").trim(),
   family:String(product.family||"").trim(),
   min:Number(product.min||0)||0,
   max:Number(product.max||0)||0,
   reorder:Number(product.reorder||0)||0,
   queuedAt:new Date().toISOString(),
   attempts:0,
   lastError:""
 };
 const code=normalizeImportCode(p.code);
 const existingIndex=state.baseProductSyncQueue.findIndex(x=>normalizeImportCode(x.code)===code);
 if(existingIndex>=0)state.baseProductSyncQueue[existingIndex]={...state.baseProductSyncQueue[existingIndex],...p};
 else state.baseProductSyncQueue.push(p);
 saveLocal();
 scheduleBaseProductQueueSync();
}
function scheduleBaseProductQueueSync(delay=1500){
 if(authState.localOnly)return;
 clearTimeout(baseProductQueueTimer);
 baseProductQueueTimer=setTimeout(()=>syncBaseProductQueue(),delay);
}
async function syncBaseProductQueue(){
 if(baseProductQueueSyncing||!state.baseProductSyncQueue.length)return;
 if(authState.localOnly||!cloudConfig.enabled||!cloudReady())return;
 baseProductQueueSyncing=true;
 try{
   const batch=state.baseProductSyncQueue.slice(0,100);
   await saveBaseProductsDirect(batch);
   await new Promise(r=>setTimeout(r,700));
   const base=await getBaseProductsFromSheets();
   const sent=new Set(batch.map(p=>normalizeImportCode(p.code)));
   const confirmed=new Set(batch.filter(p=>{
     const found=base.get(normalizeImportCode(p.code));
     if(!found)return false;
     return catalogText(found.catalog).trim()===catalogText(p.catalog).trim() &&
       String(found.description||"").trim()===String(p.description||"").trim() &&
       String(found.family||"").trim()===String(p.family||"").trim() &&
       Number(found.min||0)===Number(p.min||0) &&
       Number(found.max||0)===Number(p.max||0) &&
       Number(found.reorder||0)===Number(p.reorder||0);
   }).map(p=>normalizeImportCode(p.code)));
   state.baseProductSyncQueue=state.baseProductSyncQueue.filter(item=>{
     const code=normalizeImportCode(item.code);
     if(sent.has(code)&&confirmed.has(code))return false;
     if(sent.has(code)){
       item.attempts=Number(item.attempts||0)+1;
       item.lastError="Google Sheets todavía no confirmó el código";
     }
     return true;
   });
   saveLocal();
   updateBaseQueueUI();
   if(state.baseProductSyncQueue.length)scheduleBaseProductQueueSync(12000);
 }catch(err){
   console.error(err);
   state.baseProductSyncQueue.forEach(item=>{
     item.attempts=Number(item.attempts||0)+1;
     item.lastError=String(err?.message||"Error de sincronización");
   });
   saveLocal();
   updateBaseQueueUI();
   scheduleBaseProductQueueSync(20000);
 }finally{
   baseProductQueueSyncing=false;
 }
}
function updateBaseQueueUI(){
 const count=state.baseProductSyncQueue.length;
 const el=$("#baseQueueCount");if(el)el.textContent=String(count);
 const status=$("#baseQueueStatus");
 if(status)status.textContent=count
   ? `${count} guardado(s) en PC pendiente(s) de entrar a BASE_PRODUCTOS`
   : "Todos los códigos guardados ya están en BASE_PRODUCTOS";
}
async function saveOneBaseProductDirect(p){
 const r=await cloudJsonp("save_base_product",{
   code:String(p.code||"").trim(),
   catalog:catalogText(p.catalog).trim(),
   description:String(p.description||"").trim(),
   family:String(p.family||"").trim(),
   min:Number(p.min||0)||0,
   max:Number(p.max||0)||0,
   reorder:Number(p.reorder||0)||0
 });
 if(!r||!r.ok){
   const msg=String(r?.error||"No se pudo guardar en BASE_PRODUCTOS.");
   if(/acción no válida|accion no valida/i.test(msg)){
     throw new Error("Apps Script está desactualizado. Publica una NUEVA VERSIÓN con el Code.gs de V31.");
   }
   throw new Error(msg);
 }
 if(!r.saved)throw new Error("Google Sheets no confirmó el guardado.");
 return r;
}
async function saveBaseProductsDirect(products){
 if(!cloudConfig.enabled||!cloudReady())throw new Error("Google Sheets no está conectado.");
 const list=Array.isArray(products)?products:[];
 const groupSize=5;
 for(let i=0;i<list.length;i+=groupSize){
   const group=list.slice(i,i+groupSize);
   await Promise.all(group.map(p=>saveOneBaseProductDirect(p)));
 }
 return true;
}
async function verifySavedBaseCodes(codes){
 const base=await getBaseProductsFromSheets();
 return codes.every(code=>base.has(normalizeImportCode(code)));
}
async function savePendingBaseIndex(index){
 const p=state.pendingBaseProducts[index];
 if(!p)return;
 if(!pendingBaseComplete(p)){
   toast("Completa Descripción, Familia, Mín. y Máx. El Catálogo puede quedar vacío.");
   return;
 }
 updatePendingInventory(index);
 const saved={...p,status:"Guardado en PC"};
 state.pendingBaseProducts.splice(index,1);
 enqueueBaseProductSync(saved);
 saveLocal();
 render();
 toast("Guardado en la PC. Se sincronizará automáticamente con BASE_PRODUCTOS.");
}
async function saveAllPendingBase(){
 const list=[...state.pendingBaseProducts];
 if(!list.length)return;
 const incomplete=list.filter(p=>!pendingBaseComplete(p));
 if(incomplete.length){
   toast(`Faltan datos en ${incomplete.length} código(s). El Catálogo puede quedar vacío.`);
   return;
 }
 if(!confirm(`¿Guardar ${list.length} código(s) primero en esta PC y sincronizarlos automáticamente después?`))return;
 list.forEach((p,i)=>{
   updatePendingInventory(i);
   enqueueBaseProductSync({...p,status:"Guardado en PC"});
 });
 state.pendingBaseProducts=[];
 saveLocal();
 render();
 toast("Códigos guardados en la PC. Sincronización automática iniciada.");
}
async function refreshPendingAgainstBase(){
 try{
   toast("Verificando BASE_PRODUCTOS...");
   const base=await getBaseProductsFromSheets();
   const keep=[];
   state.pendingBaseProducts.forEach(p=>{
     const found=base.get(normalizeImportCode(p.code));
     if(found){
       const inv=state.inventory.find(x=>normalizeImportCode(x.code)===normalizeImportCode(p.code));
       if(inv){
         inv.catalog=found.catalog||inv.catalog||"";
         inv.min=Number(found.min||0)||0;
         inv.max=Number(found.max||0)||0;
         inv.reorder=Math.max(0,inv.max-Number(inv.stock||0));
       }
     }else keep.push(p);
   });
   state.pendingBaseProducts=keep;
   save();
   render();
   toast(`${keep.length} código(s) siguen pendientes.`);
 }catch(err){
   console.error(err);
   toast(err?.message||"No se pudo verificar BASE_PRODUCTOS.");
 }
}
function bindNewCodes(){
 $$("[data-pending-field]").forEach(input=>{
   input.oninput=()=>{
     const i=Number(input.dataset.pendingIndex);
     const field=input.dataset.pendingField;
     const p=state.pendingBaseProducts[i];
     if(!p)return;
     if(field==="min"||field==="max")p[field]=Math.max(0,Number(input.value)||0);
     else p[field]=input.value;
     updatePendingInventory(i);
     save();
   };
 });
 $$("[data-save-base-index]").forEach(btn=>btn.onclick=()=>savePendingBaseIndex(Number(btn.dataset.saveBaseIndex)));
 const all=$("#saveAllNewBase");if(all)all.onclick=saveAllPendingBase;
 const refresh=$("#refreshBasePending");if(refresh)refresh.onclick=refreshPendingAgainstBase;
 const syncNow=$("#syncBaseQueueNow");if(syncNow)syncNow.onclick=()=>{
   if(!cloudConfig.enabled||!cloudReady())return toast("Los datos ya están guardados en la PC. Conecta Google Sheets para sincronizarlos.");
   toast("Sincronizando códigos guardados en PC...");
   syncBaseProductQueue();
 };
 const testWrite=$("#testBaseWriteSupport");if(testWrite)testWrite.onclick=async()=>{
   try{
     const r=await cloudJsonp("ping");
     if(!r||!r.ok)throw new Error(r?.error||"No se pudo consultar Apps Script.");
     if(!r.saveBaseProduct){
       throw new Error("Apps Script no es V31. Publica una NUEVA VERSIÓN con el Code.gs incluido.");
     }
     toast("Apps Script V31 listo para guardar directamente en BASE_PRODUCTOS.");
   }catch(err){
     toast(err?.message||"No se pudo comprobar el guardado.");
   }
 };
 updateBaseQueueUI();
}
function bindTools(){
 let e=$("#exportCsv");if(e)e.onclick=csv;

 const txtInput=$("#inventoryTxtFile");

 $$("[data-tool]").forEach(b=>b.onclick=()=>{
   const tool=b.dataset.tool;

   if(tool==="import-inventory"){
     if(!cloudConfig.enabled||!cloudReady()){
       toast("Conecta Google Sheets antes de importar.");
       return;
     }
     if(txtInput)txtInput.click();
     return;
   }

   if(tool==="csv")csv();
   if(tool==="backup")backup();

   if(tool==="reset"){
     if(!confirm("¿Limpiar solamente la copia guardada en este navegador? Google Sheets NO se borrará."))return;

     clearTimeout(cloudSyncTimer);
     state.inventory=[];
     state.movements=[];
     state.counts=[];
     state.weeklyCounts={};
     state.digitalCounts={};
     state.digitalFilter={family:"",search:"",field:"name",condition:"none",value1:"",value2:"",responsible:""};
     state.digitalClosedFamilies={};
     state.digitalAdjustments=[];
     state.differenceHistory=[];
     state.pendingBaseProducts=[];
     state.baseProductSyncQueue=[];
     state.stockoutRecords=[];
     state.weeklyMeta={active:false,label:"",responsible:"",closed:false,filterFamily:"",dateFrom:"",dateTo:"",productIds:[],extraProducts:[]};
     state.weeklyHistoryMeta=[];
     state.weeklyArchiveQueue=[];
     state.settings={name:"Mi Bodega",dark:false,technicians:[],keepers:[]};

     // Guardar solo localmente: nunca enviar este vaciado a Google Sheets.
     saveLocal();
     document.body.classList.remove("dark");
     render();

     if(cloudConfig.enabled&&cloudReady()){
       toast("Copia local limpia. Recuperando datos centrales...");
       setTimeout(()=>syncFromCloud(false),250);
     }else{
       toast("Copia local limpia. La base central no fue modificada.");
     }
     return;
   }

   if(tool==="sync-all"){
     syncEverythingNow();
     return;
   }

   if(tool==="diagnostics"){
     runSystemDiagnostics();
     return;
   }
 });

 if(txtInput)txtInput.onchange=async()=>{
   const file=txtInput.files?.[0];
   txtInput.value="";
   if(file)await importInventoryTxt(file);
 };

 const testBase=$("#testBaseProductsBtn");
 if(testBase)testBase.onclick=async()=>{
   try{
     toast("Probando BASE_PRODUCTOS...");
     const base=await getBaseProductsFromSheets();
     toast(`BASE_PRODUCTOS correcta: ${base.size} códigos disponibles.`);
   }catch(err){
     console.error(err);
     toast(err?.message||"No se pudo consultar BASE_PRODUCTOS.");
   }
 };
}
function bindConfig(){
 let s=$("#saveCfg");if(!s)return;

 const logoFile=$("#logoFileInput");
 const chooseLogo=$("#chooseLogoBtn");
 const removeLogo=$("#removeLogoBtn");
 if(chooseLogo&&logoFile)chooseLogo.onclick=()=>logoFile.click();
 if(logoFile)logoFile.onchange=async()=>{
   const file=logoFile.files?.[0];
   if(!file)return;
   try{
     toast("Preparando logo...");
     const data=await optimizeLogoFile(file);
     state.settings.logoDataUrl=data;
     save();
     applyBranding();
     render();
     toast("Logo guardado y listo para sincronizar.");
   }catch(err){
     console.error(err);
     toast(err?.message||"No se pudo cargar el logo.");
   }
 };
 if(removeLogo)removeLogo.onclick=()=>{
   if(!validLogoDataUrl(state.settings.logoDataUrl))return;
   if(!confirm("¿Quitar el logo de la bodega?"))return;
   state.settings.logoDataUrl="";
   save();
   applyBranding();
   render();
   toast("Logo eliminado.");
 };

 $("#addTech").onclick=async()=>{
   const v=$("#newTech").value.trim();if(!v)return;
   if(!cloudReady())return toast("Conecta la base central para guardar técnicos.");
   try{toast("Guardando técnico en BASE_TECNICOS...");await setCentralStaffEntry("technician",v,true);render();toast("Técnico guardado en Google Sheets.")}catch(err){toast(err?.message||"No se pudo guardar el técnico.")}
 };
 $("#addKeeper").onclick=async()=>{
   const v=$("#newKeeper").value.trim();if(!v)return;
   if(!cloudReady())return toast("Conecta la base central para guardar bodegueros.");
   try{toast("Guardando bodeguero en BASE_BODEGUEROS...");await setCentralStaffEntry("keeper",v,true);render();toast("Bodeguero guardado en Google Sheets.")}catch(err){toast(err?.message||"No se pudo guardar el bodeguero.")}
 };
 $$('[data-remove-person]').forEach(b=>b.onclick=async()=>{
   const [t,i]=b.dataset.removePerson.split(":");
   const list=t==="tech"?state.settings.technicians:state.settings.keepers;
   const name=list[+i];if(!name)return;
   if(!confirm(`¿Desactivar ${name} de la base central?`))return;
   try{await setCentralStaffEntry(t==="tech"?"technician":"keeper",name,false);render();toast("Personal actualizado en Google Sheets.")}catch(err){toast(err?.message||"No se pudo actualizar el personal.")}
 });
 const refreshStaff=$("#refreshCentralStaff");if(refreshStaff)refreshStaff.onclick=async()=>{await syncCentralStaff(false);render()};
 const proxyCheck=$("#cloudProxy"),tokenInput=$("#cloudToken");
 if(proxyCheck&&tokenInput)proxyCheck.onchange=()=>{
   tokenInput.disabled=proxyCheck.checked;
   if(proxyCheck.checked)tokenInput.value="";
 };
 const readCloudForm=()=>{
   cloudConfig.url=normalizeCloudUrl($("#cloudUrl")?.value||cloudConfig.url);
   cloudConfig.proxy=!!$("#cloudProxy")?.checked;
   cloudConfig.token=cloudConfig.proxy?"":($("#cloudToken")?.value||cloudConfig.token).trim();
   cloudConfig.enabled=!!$("#cloudEnabled")?.checked;
   cloudConfig.autoSync=!!$("#cloudAutoSync")?.checked;
   saveCloudConfig();
 };

 const saveConnection=$("#saveCloudConnection");
 if(saveConnection)saveConnection.onclick=()=>{
   readCloudForm();
   if(cloudConfig.enabled&&!cloudReady())return toast(cloudConfig.proxy?"Falta la URL del proxy Netlify.":"Falta la URL o el token de Google Sheets.");
   cloudConfig.status=cloudConfig.enabled?"ready":"local";
   saveCloudConfig();
   updateCloudStatusUI();
   toast(cloudConfig.enabled?"Conexión guardada.":"Configuración de Google Sheets guardada.");
   if(cloudConfig.enabled&&state.baseProductSyncQueue?.length)scheduleBaseProductQueueSync(500);
 };

 const testBtn=$("#testCloudConnection");
 if(testBtn)testBtn.onclick=async()=>{
   readCloudForm();
   await testCloudConnection(true);
 };

 const pushBtn=$("#pushCloudData");
 if(pushBtn)pushBtn.onclick=async()=>{
   readCloudForm();
   if(!cloudConfig.enabled){
     cloudConfig.enabled=true;
     $("#cloudEnabled").checked=true;
     saveCloudConfig();
   }
   if(!cloudReady())return toast(cloudConfig.proxy?"Falta la URL del proxy Netlify.":"Falta la URL o el token de Google Sheets.");
   if(!confirm("¿Subir todos los datos actuales de este dispositivo a Google Sheets?"))return;
   await syncToCloud(false);
 };

 const pullBtn=$("#pullCloudData");
 if(pullBtn)pullBtn.onclick=async()=>{
   readCloudForm();
   if(!cloudConfig.enabled){
     cloudConfig.enabled=true;
     $("#cloudEnabled").checked=true;
     saveCloudConfig();
   }
   if(!cloudReady())return toast(cloudConfig.proxy?"Falta la URL del proxy Netlify.":"Falta la URL o el token de Google Sheets.");
   if(!confirm("¿Descargar la base de Google Sheets? Reemplazará la copia local de este dispositivo."))return;
   await syncFromCloud(false);
 };

 const disable=$("#disableCloud");
 if(disable)disable.onclick=()=>{
   cloudConfig.enabled=false;
   cloudConfig.status="local";
   saveCloudConfig();
   updateCloudStatusUI();
   const chk=$("#cloudEnabled");if(chk)chk.checked=false;
   toast("Modo local activado.");
 };

 const factoryResetBtn=$("#factoryResetBtn");
 if(factoryResetBtn)factoryResetBtn.onclick=async()=>{
   readCloudForm();
   if(!cloudConfig.enabled||!cloudReady())return toast("Para restablecer a fábrica debes estar conectado a Google Sheets.");
   const first=confirm("RESTABLECER A FÁBRICA borrará todos los datos operativos e historiales de Mi Bodega en Google Sheets y en este dispositivo. BASE_PRODUCTOS se conservará. ¿Deseas continuar?");
   if(!first)return;
   const typed=prompt("Para confirmar escribe exactamente: RESTABLECER");
   if(String(typed||"").trim().toUpperCase()!=="RESTABLECER")return toast("Restablecimiento cancelado.");
   if(!confirm("ÚLTIMA CONFIRMACIÓN: se borrarán Inventario, Salidas, Conteos, Diferencias, Historiales, Técnicos y Bodegueros. Esta acción no se puede deshacer. ¿Continuar?"))return;
   factoryResetBtn.disabled=true;
   try{
     toast("Restableciendo Mi Bodega a fábrica...");
     const r=await cloudPostAction("factory_reset",{confirmText:"RESTABLECER"});
     const at=resetLocalToFactory(r.factoryResetAt||new Date().toISOString());
     if(r.revision){centralRevision=String(r.revision);localStorage.setItem(CENTRAL_REVISION_KEY,centralRevision);}
     render();
     updateCloudStatusUI();
     updateLiveStatusUI();
     try{await initializeLiveSync();}catch{}
     toast("Sistema restablecido a fábrica. BASE_PRODUCTOS se conservó.");
     console.info("Restablecimiento de fábrica completado",at);
   }catch(err){
     console.error(err);
     toast(err?.message||"No se pudo restablecer el sistema.");
   }finally{factoryResetBtn.disabled=false;}
 };

 s.onclick=()=>{
   state.settings.name=$("#cfgName").value.trim()||"Mi Bodega";
   applyBranding();
   readCloudForm();
   save();
   toast("Configuración guardada.");
 };
}
$("#productForm").onsubmit=async e=>{
 e.preventDefault();

 const code=$("#pCode").value.trim();
 const catalog=catalogText($("#pCatalog").value).trim();
 const name=$("#pName").value.trim();
 const family=$("#pFamily").value.trim();
 const location=$("#pLocation").value.trim();
 const stock=Number($("#pStock").value);
 const min=Number($("#pMin").value);
 const max=Number($("#pMax").value);

 if(!code)return toast("El Código es obligatorio.");
 if(!name)return toast("La Descripción es obligatoria.");
 if(!family)return toast("La Familia es obligatoria.");
 if(!Number.isFinite(stock)||stock<0)return toast("Existencia inválida.");
 if(!Number.isFinite(min)||min<0)return toast("Mínimo inválido.");
 if(!Number.isFinite(max)||max<0)return toast("Máximo inválido.");
 if(max<min)return toast("El Máximo no puede ser menor que el Mínimo.");

 const duplicate=state.inventory.find(p=>
   stockoutCode(p.code)===stockoutCode(code)&&p.id!==editingProductId
 );
 if(duplicate)return toast("Ese Código ya existe en Inventario.");

 const wasEditing=!!editingProductId;
 const productNow=new Date().toISOString();
 const data={
   code,catalog,name,family,location,
   stock,min,max,
   reorder:Math.max(0,max-stock),
   stockUpdatedAt:productNow
 };
 state.inventoryVersionAt=productNow;

 if(editingProductId){
   const p=state.inventory.find(x=>x.id===editingProductId);
   if(!p)return toast("Producto no encontrado.");
   Object.assign(p,data);
   toast("Producto actualizado.");
 }else{
   state.inventory.push({id:uid(),...data,importOrder:nextMasterImportOrder()});
   toast("Producto agregado.");
 }

 syncStockoutRecordsFromInventory("Edición de Inventario");
 save();

 // V80.3.3: al editar Inventario también se actualiza la ficha maestra en BASE_PRODUCTOS.
 // Se guardan Código, Catálogo, Descripción, Familia, Mín., Máx. y Reposición.
 const baseMaster={
   code,catalog,description:name,family,min,max,
   reorder:Math.max(0,max-stock)
 };
 enqueueBaseProductSync(baseMaster);

 $("#productDialog").close();
 editingProductId=null;
 render();

 // Intentar sincronizar de inmediato; si no hay Internet, la cola queda guardada localmente.
 if(cloudConfig.enabled&&cloudReady()&&!authState.localOnly){
   await syncBaseProductQueue();
   const pending=state.baseProductSyncQueue.some(x=>normalizeImportCode(x.code)===normalizeImportCode(code));
   const actionText=wasEditing?"Producto actualizado":"Producto agregado";
   toast(pending
     ? `${actionText}. BASE_PRODUCTOS quedó pendiente de sincronizar.`
     : `${actionText} y guardado en BASE_PRODUCTOS.`);
 }else{
   const actionText=wasEditing?"Producto actualizado":"Producto agregado";
   toast(`${actionText}. BASE_PRODUCTOS se sincronizará cuando vuelva la conexión.`);
 }
}
["pStock","pMax"].forEach(id=>{
 const el=$("#"+id);
 if(el)el.addEventListener("input",refreshProductReorder);
});

$("#digitalResponsibleForm").onsubmit=e=>{
 e.preventDefault();
 const selected=$("#digitalResponsibleSelect").value.trim();
 const custom=$("#digitalResponsibleCustom").value.trim();
 const responsible=custom||selected;
 if(!responsible)return toast("Selecciona o escribe un responsable.");

 const changed=state.digitalFilter.responsible && state.digitalFilter.responsible!==responsible;
 if(changed && Object.values(state.digitalCounts).some(c=>c&&c.physical!==""&&c.physical!==null&&c.physical!==undefined)){
   if(!confirm("Ya existen conteos físicos. ¿Cambiar el responsable para los próximos conteos? Los registros ya realizados conservarán su responsable original."))return;
 }

 state.digitalFilter.responsible=responsible;
 save();
 $("#digitalResponsibleDialog").close();
 render();
 toast(`Responsable asignado: ${responsible}`);
}
$("#createWeekForm").onsubmit=e=>{
 e.preventDefault();
 const label=$("#cwLabel").value.trim(),responsible=$("#cwResponsible").value.trim();
 if(!label)return toast("Escribe el nombre de la semana.");
 if(!responsible)return toast("Asigna un responsable.");
 state.weeklyCounts={};
 state.weeklyMeta={active:true,label,responsible,closed:false,filterFamily:"",dateFrom:"",dateTo:"",productIds:[],extraProducts:[],lastArchiveId:"",closedAt:"",orderSource:"",templateCodeCount:0};
 save();$("#createWeekDialog").close();render();toast("Semana creada. Ahora puedes importar códigos o traer productos.");
}
$("#editQtyForm").onsubmit=async e=>{
 e.preventDefault();
 const m=state.movements.find(x=>x.id===editingMovementId),p=itemForMovement(m);if(!m||!p)return toast("No se encontró la salida.");
 const raw=$("#eqQty").value.trim(),n=+raw,old=+m.qty,current=+p.stock,max=current+old;
 if(raw===""||!Number.isInteger(n)||n<1)return toast("Cantidad inválida.");if(n>max)return toast(`Máximo permitido: ${max}`);
 if(liveRealtimeReady()){
   try{const r=await cloudPostAction("live_movement_qty",{movementId:m.id,qty:n});if(r.movement)applyLiveMovementUpsert(r.movement);if(r.product)applyLiveProductStock(r.product);saveLocal();$("#editQtyDialog").close();editingMovementId=null;render();toast("Cantidad actualizada.");}
   catch(err){toast(err?.message||"No se pudo actualizar la salida.");}
   return;
 }
 p.stock=current+old-n;p.reorder=Math.max(0,(+p.max||0)-p.stock);p.stockUpdatedAt=new Date().toISOString();syncStockoutRecordsFromInventory("Edición de Salida");m.qty=n;m.updatedAt=new Date().toISOString();save();$("#editQtyDialog").close();editingMovementId=null;render();toast("Cantidad actualizada e inventario ajustado.");
}
$("#editProductFromDetail").onclick=()=>{let p=state.inventory.find(x=>x.id===currentProductId);$("#productDetailDialog").close();if(p)openProduct(p)}
$$("[data-close]").forEach(b=>b.onclick=()=>document.getElementById(b.dataset.close).close());
$$("[data-page]").forEach(b=>b.onclick=()=>nav(b.dataset.page));
$("#menuBtn").onclick=openMenu;
$("#moreBtn").onclick=openMenu;
$("#drawerCloseBtn").onclick=closeMenu;
$("#scrim").onclick=closeMenu;
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeMenu()});

// V80.3.2 - Evitar cambios accidentales con la rueda del mouse en campos numéricos.
// Si el usuario está escribiendo una cantidad y mueve la rueda, el campo pierde el foco
// antes de la acción predeterminada del navegador. Así la página puede seguir desplazándose
// pero la cantidad NO aumenta ni disminuye accidentalmente.
document.addEventListener("wheel",e=>{
 const target=e.target instanceof Element?e.target.closest('input.no-spinner[type="number"]'):null;
 if(!target||target.disabled||document.activeElement!==target)return;
 target.blur();
},{capture:true,passive:true});
window.addEventListener("resize",()=>{if(window.innerWidth>820)closeMenu();requestAnimationFrame(()=>{syncWeeklyStickyColumns();syncDigitalStickyColumns();});});
window.addEventListener("orientationchange",()=>{setTimeout(()=>{syncWeeklyStickyColumns();syncDigitalStickyColumns();},120);});
$("#themeBtn").onclick=()=>{state.settings.dark=!state.settings.dark;document.body.classList.toggle("dark",state.settings.dark);save()};document.body.classList.toggle("dark",state.settings.dark);applyBranding();
$("#globalSearch").oninput=e=>{
 if(state.page!=="inventario")return;
 const q=e.target.value.trim().toLowerCase();
 const items=q
   ? orderedProducts(state.inventory.filter(p=>
       `${p.code} ${p.catalog} ${p.name} ${p.family} ${p.location}`.toLowerCase().includes(q)
     ))
   : orderedProducts(state.inventory);
 $("#content").innerHTML=renderInventario(items);
 $$("[data-page]").forEach(b=>b.classList.toggle("active",b.dataset.page==="inventario"));
 bind();
}

window.addEventListener("error",e=>{
 const msg=String(e?.message||"Error inesperado");
 console.error("Mi Bodega:",e?.error||e);
 if(/is not defined/i.test(msg)){
   try{toast("Error interno detectado: "+msg)}catch{}
 }
});
document.addEventListener("click",()=>{
 closeWeeklyMenus();
 const dm=$("#digitalConditionMenu");
 if(dm)dm.hidden=true;
});
window.addEventListener("online",()=>{
 if(cloudConfig.enabled&&cloudReady()){
   if(cloudConfig.autoSync){
     if(hasUnsyncedLocalChanges())queueCloudSync(350);
     else pollLiveEvents(true);
     startLivePolling();
   }
   if(state.baseProductSyncQueue?.length)scheduleBaseProductQueueSync(350);
   if(pendingDifferenceSyncCount())scheduleDifferenceHistorySync(350);
   if(pendingWeeklyArchiveCount())setTimeout(()=>syncWeeklyArchiveQueue(false),500);
   if(pendingDigitalArchiveCount())setTimeout(()=>syncDigitalArchiveQueue(false),650);
 }
});
document.addEventListener("visibilitychange",()=>{
 if(document.visibilityState==="hidden")stopLivePolling();
 if(document.visibilityState==="visible"&&cloudConfig.enabled&&cloudReady()){
   if(cloudConfig.autoSync){
     if(hasUnsyncedLocalChanges())queueCloudSync(300);
     else pollLiveEvents(true);
     startLivePolling();
   }
   if(state.baseProductSyncQueue?.length)scheduleBaseProductQueueSync(600);
   if(pendingDifferenceSyncCount())scheduleDifferenceHistorySync(600);
   if(pendingWeeklyArchiveCount())setTimeout(()=>syncWeeklyArchiveQueue(false),700);
   if(pendingDigitalArchiveCount())setTimeout(()=>syncDigitalArchiveQueue(false),850);
 }
});
render();
setTimeout(async()=>{
 if(cloudConfig.enabled&&cloudReady()){
   saveCloudConfig();
   await resumeCentralSyncAfterAuth();
 }
},250);