(function(){
  const host=String(location.hostname||"");
  const isNetlify=/\.netlify\.app$/i.test(host);
  window.MI_BODEGA_DEPLOY={
    enabled:isNetlify,
    proxy:isNetlify,
    apiUrl:isNetlify?"/api/bodega":"",
    token:""
  };
})();
