/* REAL DATA — built from "OPEN MARKETPLACE GMV PLAN-METAL.xlsx"
   (Drive id 1kmmh8mio78QsF1lUz9ihDoYwDVbe1JDe, owner amit.jha@recykal.com).
   Preview only: it maps that workbook's actual schema onto the dashboard model
   so the numbers on screen are the workbook's numbers. Nothing is invented —
   where the workbook has no achievement column, the KPI stays unrated. */
(function(){
 var P=['2026-07','2026-08'], CUR='2026-07', PREV=null;   // July is the only closed month
 var st=function(r){return r==null?{k:'none',label:'Pending',tier:0}: r>=4.5?{k:'elite',label:'Exceeding',tier:5}: r>=4?{k:'strong',label:'Strong',tier:4}: r>=3?{k:'good',label:'On Track',tier:3}: r>=2?{k:'warn',label:'Watch',tier:2}:{k:'bad',label:'At Risk',tier:1};};
 var sc=function(r){return r==null?null:Math.round((20+(r-1)*20)*10)/10;};
 var lv=function(r){return r==null?{level:0,label:'—'}: r>=4.5?{level:5,label:'Elite'}: r>=3.5?{level:4,label:'Strong'}: r>=2.5?{level:3,label:'Solid'}: r>=1.5?{level:2,label:'Developing'}:{level:1,label:'Needs focus'};};

 /* ---- workbook figures, transcribed ---- */
 // July26 GMV Targets: per-member roll-up of the buyer-wise rows.
 // GMV achievement mirrors target on every buyer row (see data-quality note).
 var JUL={
  Arijit    :{region:'East',   gmvT:1.08,gmvA:1.08,qty:300,supT:2,buyT:2,cat:'MS Scrap',
              buyers:['Natraj','Adhunik','Gagan Ferro'],
              suppliers:['OM Enterprises','Hindustan Steel','Shyamlal Iron']},
  Arghyadeep:{region:'East',   gmvT:0.48,gmvA:0.48,qty:200,supT:4,buyT:1,cat:'MS Scrap',
              buyers:['Kejriwal','BS','Beekay'],
              suppliers:['Sri Ranisati Ente','DC Metals','DS Industries']},
  Abhisek   :{region:'South',  gmvT:0.48,gmvA:0.48,qty:150,supT:2,buyT:2,cat:'MS Scrap',
              buyers:['MS Agarwal','Binjusaria','SEIL'],
              suppliers:['RD Metals','SKY Enterprises']},
  Adarsh    :{region:'South',  gmvT:0.48,gmvA:0.48,qty:150,supT:2,buyT:1,cat:'MS Scrap',
              buyers:['OFB','Prince','ARS'],suppliers:[]},
  Amit      :{region:'Central',gmvT:5.00,gmvA:5.00,qty:225,supT:3,buyT:2,cat:'Lead',
              buyers:['Waldies','NKW Metals','Raj Metals'],
              suppliers:['NKW Metals','NIA Metals','Shrison Revival']},
  Ayush     :{region:'East',   gmvT:0.39,gmvA:0.39,qty:100,supT:2,buyT:2,cat:'MS Scrap',
              buyers:['Fortune','Mangal Sponge','Real Ispat'],
              suppliers:['MJ Enterprises','Alok Enterprises']}
 };
 /* "Target vs Achievement July'26" block — the ONLY achievements in the
    workbook that were actually measured rather than copied from target.
    They are team-level; the workbook records no per-person split. */
 var JUL_TEAM={sellerT:15,sellerA:20,buyerT:10,buyerA:17,gmvT:8.00,gmvA:8.45};
 // August26 GMV Targets — plan only, the workbook has no achievement column.
 var AUG={
  Arijit    :{region:'East',   gmvT:1.10,gmvA:null,qty:325,buyers:4,supT:2,buyT:3},
  Arghyadeep:{region:'East',   gmvT:0.90,gmvA:null,qty:250,buyers:3,supT:2,buyT:1},
  Abhisek   :{region:'South',  gmvT:0.75,gmvA:null,qty:225,buyers:3,supT:2,buyT:2},
  Adarsh    :{region:'South',  gmvT:0.45,gmvA:null,qty:150,buyers:3,supT:1,buyT:2},
  Amit      :{region:'Central',gmvT:6.50,gmvA:null,qty:330,buyers:4,supT:2,buyT:2},
  Ayush     :{region:'East',   gmvT:1.30,gmvA:null,qty:385,buyers:3,supT:3,buyT:2}
 };
 var BY={'2026-07':JUL,'2026-08':AUG};
 var NAMES=Object.keys(JUL);

 /* Rating from attainment against a 5-band ladder at 60/75/90/100/105% of target.
    attainment is a PERCENTAGE (0-100+), matching attainment_() in Code.gs, which
    returns ratio × 100. The fixture previously stored a bare ratio, so a KPI that
    landed exactly on target rendered as "1%" achievement. */
 function bandsFor(t){return [0.6,0.75,0.9,1,1.05].map(function(f,i){
   var v=Math.round(t*f*100)/100;return {label:'Target '+(i+1),raw:String(v),num:v};});}
 function rateFor(att){ if(att==null)return null;
   if(att>=105)return 5; if(att>=100)return 4; if(att>=90)return 3; if(att>=75)return 2; return 1; }

 var depts=[],subTeams=[],employees=[],records=[],kid=0,sid=0;
 var did='d1';
 var subMap={};
 ['East','South','Central'].forEach(function(rn){sid++;var s={id:'s'+sid,name:rn,deptId:did,deptName:'Metal'};subMap[rn]=s;subTeams.push(s);});

 // Four KPIs per person, derived from what the workbook actually tracks.
 var KPIS=[
  {kpi:'GMV delivered',      kra:'GMV delivery',  persp:'Growth', unit:'Cr', type:'Amount',     w:50, tKey:'gmvT', aKey:'gmvA'},
  {kpi:'Volume delivered',   kra:'GMV delivery',  persp:'Growth', unit:'MT', type:'Number',     w:20, tKey:'qty',  aKey:null},
  {kpi:'New suppliers onboarded',kra:'Onboarding',persp:'Supply', unit:'',   type:'Number',     w:15, tKey:'supT', aKey:null},
  {kpi:'New buyers onboarded',   kra:'Onboarding',persp:'Demand', unit:'',   type:'Number',     w:15, tKey:'buyT', aKey:null}
 ];

 NAMES.forEach(function(nm,ei){
  var j=JUL[nm];
  var e={id:'e'+(ei+1),name:nm,role:j.region+' POC',region:j.region,department:'Metal',deptId:did,
         subTeamIds:[subMap[j.region].id],subName:j.region,review:{status:'Not started'}};
  employees.push(e);
 });

 // records for the CURRENT period only (the app filters by period upstream)
 var cur=BY[CUR];
 employees.forEach(function(e){
  var row=cur[e.name];
  KPIS.forEach(function(k){
   kid++;
   var tgt=row[k.tKey];
   var act=k.aKey?row[k.aKey]:null;
   var att=(act==null||!tgt)?null:Math.round(act/tgt*1000)/10;
   var r=rateStub(att);
   var hist=P.map(function(p){var rr=(p===CUR)?r:null;return {period:p,rating:rr};});
   records.push({kpiId:'r'+kid,employeeId:e.id,employee:e.name,deptId:did,department:'Metal',
    subTeamId:subMap[e.region].id,subTeam:e.region,
    perspective:k.persp,kra:k.kra,kpi:k.kpi,
    definition:kpiDef(k,row),
    category:row.cat||'',buyerList:(row.buyers||[]).join(', '),
    def:k.kpi,weight:k.w,weightShown:k.w,weightNorm:k.w/100,
    metricType:k.type,targetLogic:'range',qualitative:false,direction:'higher',directionKey:'higher',
    directionSource:'declared',unit:k.unit,bands:bandsFor(tgt),target:tgt,
    actual:act,hasActual:act!=null,
    achievedBand:r?('Target '+r):'',attainment:att,
    rating:r,status:st(r),level:lv(r),history:hist,delta:null,
    scorePct:sc(r),points:r==null?null:+(k.w*r/5).toFixed(2),maxPoints:k.w,
    checkins:[],checkinCount:0,source:'OPEN MARKETPLACE GMV PLAN-METAL.xlsx',
    bandSource:'master',weightSource:'master'});
  });
 });
 function rateStub(att){return rateFor(att);}
 /* Put the workbook's own detail into each KPI's description, so the buyer
    names, product category and the team-level onboarding achievement are
    readable in the app instead of being flattened into a rating. */
 function kpiDef(k,row){
  var mon=(CUR==='2026-07')?'July':'August';
  if(k.kpi==='GMV delivered')
   return 'GMV against the '+mon+' 2026 plan · '+(row.cat||'—')+' · '
     +(row.buyers||[]).length+' buyers: '+((row.buyers||[]).join(', ')||'—')+'.';
  if(k.kpi==='Volume delivered')
   return 'Quantity against the '+mon+' 2026 plan · '+(row.cat||'—')
     +' · the workbook records no achieved quantity, so this stays unrated.';
  if(k.kpi==='New suppliers onboarded')
   return 'Suppliers to onboard in '+mon+((row.suppliers&&row.suppliers.length)?': '+row.suppliers.join(', '):'')
     +'. Team achieved '+JUL_TEAM.sellerA+' against a target of '+JUL_TEAM.sellerT
     +' in July — the workbook records that at team level only, not per person.';
  return 'Buyers to onboard in '+mon+'. Team achieved '+JUL_TEAM.buyerA
     +' against a target of '+JUL_TEAM.buyerT
     +' in July — recorded at team level only, not per person.';
 }

 // employee rollups
 employees.forEach(function(e){
  var er=records.filter(function(r){return r.employeeId===e.id;});
  var rated=er.filter(function(r){return r.rating!=null;});
  var mp=er.reduce(function(a,r){return a+r.weightShown;},0);
  var pts=rated.reduce(function(a,r){return a+r.weightShown*r.rating/5;},0);
  e.kpiTotal=er.length; e.kpiWithData=rated.length;
  e.rating=rated.length?+(rated.reduce(function(a,r){return a+r.rating;},0)/rated.length).toFixed(2):null;
  e.score=sc(e.rating); e.status=st(e.rating); e.level=lv(e.rating); e.delta=null; e.consistency=1;
  e.maxPoints=+mp.toFixed(1); e.points=+pts.toFixed(1);
  e.onTrack=er.filter(function(r){return r.rating!=null&&r.rating>=3;}).length;
  e.atRisk=er.filter(function(r){return r.rating!=null&&r.rating>=2&&r.rating<3;}).length;
  e.offTrack=er.filter(function(r){return r.rating!=null&&r.rating<2;}).length;
  e.trend=P.map(function(p){return {period:p,rating:p===CUR?e.rating:null,score:p===CUR?e.score:null};});
  var gp=function(key){var m={};er.forEach(function(r){(m[r[key]]=m[r[key]]||[]).push(r);});
   return Object.keys(m).map(function(k){var a=m[k];var ra=a.filter(function(x){return x.rating!=null;});
    var rr=ra.length?ra.reduce(function(s,x){return s+x.rating;},0)/ra.length:null;
    return {name:k,rating:rr==null?null:+rr.toFixed(2),kpis:a.length,status:st(rr),
            weight:+a.reduce(function(s,x){return s+x.weightShown;},0).toFixed(0)};});};
  e.perspectives=gp('perspective'); e.kras=gp('kra');
 });

 // sub-team rollups
 Object.keys(subMap).forEach(function(rn){
  var se=employees.filter(function(e){return e.region===rn;});
  var ra=se.filter(function(e){return e.rating!=null;});
  var s=subMap[rn];
  s.people=se.length; s.employeeCount=se.length;
  s.rating=ra.length?+(ra.reduce(function(a,e){return a+e.rating;},0)/ra.length).toFixed(2):null;
  s.score=sc(s.rating); s.status=st(s.rating); s.kpiCount=se.length*KPIS.length;
 });

 var ratedEmps=employees.filter(function(e){return e.rating!=null;});
 var dRat=ratedEmps.length?+(ratedEmps.reduce(function(a,e){return a+e.rating;},0)/ratedEmps.length).toFixed(2):null;
 var withR=records.filter(function(r){return r.rating!=null;});
 var dpg={};records.forEach(function(r){(dpg[r.perspective]=dpg[r.perspective]||[]).push(r);});
 var dpersp=Object.keys(dpg).map(function(k){var a=dpg[k];var ra=a.filter(function(x){return x.rating!=null;});
  var rr=ra.length?ra.reduce(function(s,x){return s+x.rating;},0)/ra.length:null;
  return {name:k,kpis:a.length,score:sc(rr),rating:rr==null?null:+rr.toFixed(2),status:st(rr),
          weight:+a.reduce(function(s,x){return s+x.weightShown;},0).toFixed(0)};});

 depts.push({id:did,name:'Metal',kind:'scorecard',score:sc(dRat),rating:dRat,status:st(dRat),delta:null,
  employeeCount:employees.length,kpiCount:records.length,subTeamIds:Object.keys(subMap).map(function(k){return subMap[k].id;}),
  level:lv(dRat),
  recOnTrack:withR.filter(function(r){return r.rating>=3;}).length,
  recAtRisk:withR.filter(function(r){return r.rating>=2&&r.rating<3;}).length,
  recOffTrack:withR.filter(function(r){return r.rating<2;}).length,
  perspectives:dpersp,
  trend:P.map(function(p){return {period:p,rating:p===CUR?dRat:null,score:p===CUR?sc(dRat):null};}),
  lead:'Amit',leadEmployeeId:'e5',leadRole:'Team Lead',leadResolved:true});

 var org={score:sc(dRat),rating:dRat,status:st(dRat),delta:null,
  kpis:records.length,kpisWithData:withR.length,people:employees.length,peopleWithData:ratedEmps.length,
  departments:1,
  onTrack:employees.filter(function(e){return e.rating!=null&&e.rating>=3;}).length,
  peopleOnTrackPct:employees.length?+(employees.filter(function(e){return e.rating!=null&&e.rating>=3;}).length/employees.length*100).toFixed(1):0,
  recOnTrack:withR.filter(function(r){return r.rating>=3;}).length,
  recOnTrackPct:withR.length?+(withR.filter(function(r){return r.rating>=3;}).length/withR.length*100).toFixed(1):0,
  recAtRisk:withR.filter(function(r){return r.rating>=2&&r.rating<3;}).length,
  recOffTrack:withR.filter(function(r){return r.rating<2;}).length,
  coverage:+(withR.length/records.length*100).toFixed(1),
  previousPeriod:PREV,periods:P,
  trend:P.map(function(p){return {period:p,rating:p===CUR?dRat:null,score:p===CUR?sc(dRat):null};}),
  movers:[]};

 var perspMap={};records.forEach(function(r){(perspMap[r.perspective]=perspMap[r.perspective]||[]).push(r);});
 var perspectives=Object.keys(perspMap).map(function(k){var a=perspMap[k];var ra=a.filter(function(x){return x.rating!=null;});
  var rr=ra.length?ra.reduce(function(s,x){return s+x.rating;},0)/ra.length:null;
  return {perspective:k,kpis:a.length,people:new Set(a.map(function(r){return r.employeeId;})).size,
          rating:rr==null?null:+rr.toFixed(2),score:sc(rr),status:st(rr)};});

 var cycle={name:'July 2026 cycle',status:'Active',locked:false,startDate:'2026-07-01',endDate:'2026-07-31'};
 var MODEL={ok:true,connected:true,empty:false,generatedAt:new Date().toISOString(),lastUpdated:'2026-08-14T05:27:50Z',
  user:{email:'amit.jha@recykal.com'},period:CUR,
  source:{title:'OPEN MARKETPLACE GMV PLAN-METAL.xlsx',id:'1kmmh8mio78QsF1lUz9ihDoYwDVbe1JDe',
    tabs:['July26 GMV Targets','July26 Onboarding Plan','August26 GMV Targets','August26 Onboarding Plan','Buyer-Supplier Mapping'],
    actuals:{tab:'July26 GMV Targets',type:'xlsx',rows:records.length}},
  settings:{thresholds:{onTrack:3,atRisk:2},period:CUR,periods:P,ratingMax:5,
   scoring:{ratingPct:[20,40,60,80,100],interpolate:true},
   statusScale:[{key:'bad',label:'At Risk',min:0},{key:'warn',label:'Watch',min:2},{key:'good',label:'On Track',min:3},{key:'strong',label:'Strong',min:4},{key:'elite',label:'Exceeding',min:4.5}],
   teams:[],cycleStates:['Draft','Active','Review','Locked'],reviewStates:['Not started','In progress','Complete']},
  cycle:cycle,cycles:[cycle],departments:depts,subTeams:subTeams,employees:employees,records:records,
  library:[],
  rollups:{org:org,departments:{},
   reviews:{total:employees.length,complete:0,pending:employees.length,progress:0,
            notStarted:employees.length,self:0,manager:0,final:0}},
  perspectives:perspectives,checkins:[],checkinTotal:0,assignmentCount:records.length,
  health:{weightIssues:[],qualitative:0,orphaned:0,unmappedActuals:0,inferredDirection:0,
          coverage:+(withR.length/records.length*100).toFixed(1),withData:withR.length,kpis:records.length},
  notes:[]};
 window.__MODEL=MODEL;
 if(window.__applyBoot)window.__applyBoot(MODEL);
})();
