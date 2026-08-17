/* Demo fixture for local preview / shareable brand preview only — NOT part of the app.
   Builds a faithful synthetic model matching apiBootstrap's shape and applies it. */
(function(){
 const P=['2026-06','2026-07','2026-08'], CUR='2026-08', PREV='2026-07';
 const st=r=> r==null?{k:'none',label:'Pending',tier:0}: r>=4.5?{k:'elite',label:'Exceeding',tier:5}: r>=4?{k:'strong',label:'Strong',tier:4}: r>=3?{k:'good',label:'On Track',tier:3}: r>=2?{k:'warn',label:'Watch',tier:2}:{k:'bad',label:'At Risk',tier:1};
 const sc=r=> r==null?null: Math.round((20+(r-1)*20)*10)/10;
 const lv=r=> r==null?{level:0,label:'—'}: r>=4.5?{level:5,label:'Elite'}: r>=3.5?{level:4,label:'Strong'}: r>=2.5?{level:3,label:'Solid'}: r>=1.5?{level:2,label:'Developing'}:{level:1,label:'Needs focus'};
 const bands=[{label:'Target 1',raw:'0.6',num:0.6},{label:'Target 2',raw:'0.75',num:0.75},{label:'Target 3',raw:'0.9',num:0.9},{label:'Target 4',raw:'1',num:1},{label:'Target 5',raw:'1.05',num:1.05}];
 let kid=0;
 function rec(e,persp,kra,kpi,weight,rating){
  kid++; const id='r'+kid;
  const actual=+(0.6+(rating-1)/4*0.5).toFixed(3);
  const hist=P.map((p,i)=>({period:p,rating:Math.max(1,Math.min(5,+(rating-(P.length-1-i)*0.25).toFixed(2)))}));
  return {kpiId:id,employeeId:e.id,employee:e.name,deptId:e.deptId,department:e.department,subTeamId:e.subTeamIds[0]||'',subTeam:e.subName||'',
   perspective:persp,kra:kra,kpi:kpi,def:'Share of '+kpi.toLowerCase()+' delivered against the monthly target band.',
   weight:weight,weightShown:weight,weightNorm:weight/100,metricType:'Percentage',targetLogic:'range',qualitative:false,direction:'higher',unit:'%',
   bands:bands,actual:actual,hasActual:true,achievedBand:'Target '+st(rating).tier,attainment:+(actual/0.9).toFixed(3),
   rating:rating,status:st(rating),level:lv(rating),history:hist,delta:+(rating-hist[1].rating).toFixed(2),
   points:+(weight*rating/5).toFixed(2),definition:'Share of '+kpi.toLowerCase()+' against the monthly target band.'};
 }
 const specs=[
  ['Metal','scorecard','Amit Jha',[['Amit Jha','Supply',4.6],['Rohan Mehta','Supply',3.8],['Priya Nair','Supply',2.4],['Karan Shah','Demand',3.2],['Neha Gupta','Demand',4.1]]],
  ['Plastic','scorecard','Tabesh Khan',[['Tabesh Khan','Supply',3.9],['Suresh Rao','Supply',1.7],['Anita Desai','Supply',3.4],['Vikram Singh','Demand',2.9]]],
  ['Onboarding','individuals','Ajay Kumar',[['Vamsi Krishna','',4.3],['Harshita Jain','',3.1],['Naveen Reddy','',2.2]]],
  ['Collections','individuals','Srinivas Reddy',[['Sai Nitin','',3.6],['Ravi Naik','',4.7],['Ankur Bose','',1.9]]]
 ];
 const KRAS={scorecard:[['Supply','Existing seller txns','Existing seller txns'],['Supply','New seller acquisition','New seller acquisition'],['Growth','Supply GMV','Supply GMV'],['Demand','Buyer retention','Buyer retention']],
             individuals:[['Quality','Vendor onboarding TAT','Vendor onboarding TAT'],['Quality','Documentation accuracy','Documentation accuracy'],['Growth','Activation rate','Activation rate']]};
 let depts=[],subTeams=[],employees=[],records=[],eid=0,sid=0;
 specs.forEach(spec=>{
  const dn=spec[0],kind=spec[1],lead=spec[2],mem=spec[3]; const did='d'+(depts.length+1);
  const subMap={};
  const emps=mem.map(m=>{
   eid++; const e={id:'e'+eid,name:m[0],role:kind==='scorecard'?(m[1]+' POC'):'Individual contributor',region:m[1]||'—',department:dn,deptId:did,subTeamIds:[],subName:m[1]||'',rating:m[2],status:st(m[2]),delta:+((Math.random()*0.8-0.3)).toFixed(2),level:lv(m[2]),review:{status:m[2]>3.5?'Complete':(m[2]>2.5?'In progress':'Not started')}};
   if(m[1]){ if(!subMap[m[1]]){sid++;const s={id:'s'+sid,name:m[1],deptId:did,deptName:dn};subMap[m[1]]=s;subTeams.push(s);} e.subTeamIds=[subMap[m[1]].id]; }
   return e;
  });
  const kras=KRAS[kind];
  emps.forEach(e=>{ kras.forEach((k,i)=> records.push(rec(e,k[0],k[1],k[2],[15,20,40,25][i%4]||20, Math.max(1,Math.min(5,+(e.rating+(i-1)*0.3).toFixed(2)))))); });
  emps.forEach(e=>{
   const er=records.filter(r=>r.employeeId===e.id);
   e.kpiTotal=er.length; e.kpiWithData=er.filter(r=>r.rating!=null).length; e.score=sc(e.rating); e.consistency=3;
   e.trend=P.map((p,i)=>{const rr=Math.max(1,Math.min(5,+(e.rating-(P.length-1-i)*0.2).toFixed(2)));return {period:p,rating:rr,score:sc(rr)};});
   e.maxPoints=+er.reduce((a,r)=>a+r.weightShown,0).toFixed(1);
   e.points=+er.reduce((a,r)=>a+r.weightShown*r.rating/5,0).toFixed(1);
   e.onTrack=er.filter(r=>r.rating>=3).length; e.atRisk=er.filter(r=>r.rating>=2&&r.rating<3).length; e.offTrack=er.filter(r=>r.rating<2).length;
   const gp=key=>{const m={};er.forEach(r=>{const k=r[key];(m[k]=m[k]||[]).push(r);});return Object.keys(m).map(k=>{const a=m[k];const rr=a.reduce((x,y)=>x+y.rating,0)/a.length;return {name:k,rating:+rr.toFixed(2),kpis:a.length,status:st(rr),weight:+a.reduce((x,y)=>x+y.weightShown,0).toFixed(0)};});};
   e.perspectives=gp('perspective'); e.kras=gp('kra');
  });
  const rats=emps.map(e=>e.rating); const drat=rats.reduce((a,b)=>a+b,0)/rats.length;
  const leadE=emps.find(e=>e.name===lead);
  const drecs=records.filter(r=>r.deptId===did);
  const dpg={};drecs.forEach(r=>{(dpg[r.perspective]=dpg[r.perspective]||[]).push(r);});
  const dpersp=Object.keys(dpg).map(k=>{const a=dpg[k];const rr=a.reduce((x,y)=>x+y.rating,0)/a.length;return {name:k,kpis:a.length,score:sc(rr),rating:+rr.toFixed(2),status:st(rr),weight:+a.reduce((x,y)=>x+y.weightShown,0).toFixed(0)};});
  // subteam rollups
  Object.keys(subMap).forEach(nm=>{const se=emps.filter(e=>e.subName===nm);const sr=se.reduce((a,e)=>a+e.rating,0)/se.length;const s=subMap[nm];s.people=se.length;s.employeeCount=se.length;s.rating=+sr.toFixed(2);s.score=sc(sr);s.status=st(sr);s.kpiCount=se.length*kras.length;});
  depts.push({id:did,name:dn,kind:kind,score:sc(drat),rating:+drat.toFixed(2),status:st(drat),delta:0.12,
   employeeCount:emps.length,kpiCount:emps.length*kras.length,subTeamIds:Object.keys(subMap).map(k=>subMap[k].id),level:lv(drat),
   recOnTrack:drecs.filter(r=>r.rating>=3).length,recAtRisk:drecs.filter(r=>r.rating>=2&&r.rating<3).length,recOffTrack:drecs.filter(r=>r.rating<2).length,
   perspectives:dpersp,trend:P.map((p,i)=>{const rr=Math.max(1,Math.min(5,+(drat-(P.length-1-i)*0.2).toFixed(2)));return {period:p,rating:rr,score:sc(rr)};}),
   lead:lead,leadEmployeeId:leadE?leadE.id:'',leadRole:'Team Lead',leadResolved:!!leadE});
  employees=employees.concat(emps);
 });
 depts.push({id:'dinfo',name:'OMP Control Tower',kind:'info',employeeCount:0,kpiCount:0,subTeamIds:[],rawTable:{headers:['Metric','Aug','MoM'],rows:[['GMV (Cr)','182','+6%'],['Active sellers','1,240','+3%'],['Fill rate','94%','+1pt']]}});
 const withR=records.filter(r=>r.rating!=null);
 const perf=depts.filter(d=>d.kind!=='info');
 const orgRating=+(employees.reduce((a,e)=>a+e.rating,0)/employees.length).toFixed(2);
 const org={score:sc(orgRating),rating:orgRating,status:st(orgRating),delta:0.18,
  kpis:records.length,kpisWithData:withR.length,people:employees.length,peopleWithData:employees.length,departments:perf.length,
  onTrack:employees.filter(e=>e.rating>=3).length,peopleOnTrackPct:+(employees.filter(e=>e.rating>=3).length/employees.length*100).toFixed(1),
  recOnTrack:withR.filter(r=>r.rating>=3).length,recOnTrackPct:+(withR.filter(r=>r.rating>=3).length/withR.length*100).toFixed(1),
  recAtRisk:withR.filter(r=>r.rating>=2&&r.rating<3).length,recOffTrack:withR.filter(r=>r.rating<2).length,
  coverage:100,previousPeriod:PREV,periods:P,
  trend:P.map((p,i)=>({period:p,rating:+(orgRating-(P.length-1-i)*0.2).toFixed(2),score:sc(orgRating-(P.length-1-i)*0.2)})),
  movers:employees.slice().sort((a,b)=>b.delta-a.delta).map(e=>({id:e.id,name:e.name,department:e.department,delta:e.delta,score:sc(e.rating),rating:e.rating,status:e.status}))};
 const perspMap={};
 records.forEach(r=>{(perspMap[r.perspective]=perspMap[r.perspective]||[]).push(r);});
 const perspectives=Object.keys(perspMap).map(k=>{const a=perspMap[k];const rr=a.reduce((x,y)=>x+y.rating,0)/a.length;return {perspective:k,kpis:a.length,people:new Set(a.map(r=>r.employeeId)).size,rating:+rr.toFixed(2),score:sc(rr),status:st(rr)};});
 const health={weightIssues:[{employee:'Harshita Jain',sum:110,dept:'Onboarding',subTeam:'',kpis:3,gap:10}],
  qualitative:2,orphaned:0,unmappedActuals:0,inferredDirection:0,coverage:100,withData:withR.length,kpis:records.length};
 const cycle={name:'August 2026 cycle',status:'Active',locked:false,startDate:'2026-08-01',endDate:'2026-08-31'};
 const MODEL={ok:true,connected:true,empty:false,generatedAt:new Date().toISOString(),lastUpdated:new Date().toISOString(),
  user:{email:'amit.jha@recykal.com'},period:CUR,
  source:{title:'KRA/KPI Master',id:'demo',tabs:[],actuals:{tab:'KKT_Actuals',type:'sheet',rows:records.length}},
  settings:{thresholds:{onTrack:3,atRisk:2},period:CUR,periods:P,ratingMax:5,scoring:{ratingPct:[20,40,60,80,100],interpolate:true},
   statusScale:[{key:'bad',label:'At Risk',min:0},{key:'warn',label:'Watch',min:2},{key:'good',label:'On Track',min:3},{key:'strong',label:'Strong',min:4},{key:'elite',label:'Exceeding',min:4.5}],
   teams:[],cycleStates:['Draft','Active','Review','Locked'],reviewStates:['Not started','In progress','Complete']},
  cycle:cycle,cycles:[cycle],departments:depts,subTeams:subTeams,employees:employees,records:records,
  library:[],rollups:{org:org,reviews:(function(){const comp=employees.filter(e=>e.review.status==='Complete').length,prog=employees.filter(e=>e.review.status==='In progress').length,ns=employees.filter(e=>e.review.status==='Not started').length;return {total:employees.length,complete:comp,pending:employees.length-comp,progress:Math.round(comp/employees.length*100),notStarted:ns,self:prog,manager:0,final:0};})(),departments:{}},
  perspectives:perspectives,checkins:[],checkinTotal:0,assignmentCount:records.length,health:health,notes:[]};
 window.__MODEL=MODEL;
 window.__applyBoot(MODEL);
})();
