// Moved from an inline <script> so the page runs under a strict script policy.
(function(){
  /* Earned automation simulator (illustration) */
  var r=document.getElementById('corr'),n=document.getElementById('corrN'),meter=document.getElementById('meter');
  var stage=document.getElementById('stage'),share=document.getElementById('share'),ceil=document.getElementById('ceiling');
  var lad=document.querySelectorAll('#ladder > div');
  function update(){
    var v=+r.value;n.textContent=v;meter.style.width=(v/240*100)+'%';
    var s=0,pct=0,c='Not yet certified';
    if(v>=200){s=2;pct=70;c='Certified at 1% of premium';}
    else if(v>=120){s=2;pct=55;c='Certified at 1% of premium';}
    else if(v>=40){s=1;pct=Math.round(15+(v-40)/80*25);c='Certified at 2% of premium';}
    else {s=0;pct=0;}
    stage.textContent=['Assisted','Supervised','Automated'][s];
    share.textContent=pct+'%';ceil.textContent=c;
    lad.forEach(function(d,i){d.classList.toggle('on',i===s);});
  }
  r.addEventListener('input',update);update();

  /* Same answer demo */
  var money=window.pennyMoney;
  var lines=[
    {cls:'5645 Residential carpentry',who:'Your 6 carpenters',basis:'Payroll register: crews on single-family jobs',why:'Your carpenters worked on homes, so their pay goes under residential carpentry at your policy rate.',pay:312400,rate:8.14},
    {cls:'5606 Executive supervisor',who:'Your superintendent',basis:'Job records show site direction only, no tool work',why:'Your superintendent directs the crews but does not swing a hammer, so a lower-rated supervisor class applies.',pay:96000,rate:1.52},
    {cls:'8810 Clerical office',who:'Your office manager',basis:'Separate office, no site duties',why:'Your office manager works only in the office, so the clerical class applies.',pay:58200,rate:0.19},
    {cls:'5645 Uninsured subcontractor',who:'A subcontractor without coverage',basis:'1099 paid $41,800; no certificate of insurance on file',why:'A subcontractor you paid had no workers\u2019 comp certificate, so their pay counts as if they were your employees.',pay:41800,rate:8.14}
  ];
  var total=0,ar='',ir='';
  lines.forEach(function(l){var p=l.pay*l.rate/100;total+=p;
    ar+='<tr><td><strong>'+l.cls+'</strong></td><td>'+l.basis+'</td><td class="num">'+money(l.pay)+'</td><td class="num">'+l.rate.toFixed(2)+'</td><td class="num">'+money(p)+'</td></tr>';
    ir+='<tr><td><strong>'+l.who+'</strong></td><td>'+l.why+'<span class="why">Upload a certificate for the subcontractor and this line drops to $0.</span></td><td class="num">'+money(l.pay)+'</td><td class="num">'+money(p)+'</td></tr>';
  });
  ir=ir.replace(/<span class="why">Upload a certificate[^<]*<\/span>/g,'');
  ir=ir.replace(/(<td><strong>A subcontractor without coverage<\/strong><\/td><td>[^<]*)/,'$1<span class="why">Upload a certificate of insurance for this subcontractor and this line drops to $0.</span>');
  document.getElementById('aud-rows').innerHTML=ar;document.getElementById('ins-rows').innerHTML=ir;
  document.getElementById('aud-total').textContent=money(total);document.getElementById('ins-total').textContent=money(total);
  document.querySelectorAll('.seg button').forEach(function(b){b.addEventListener('click',function(){
    document.querySelectorAll('.seg button').forEach(function(x){x.setAttribute('aria-pressed',x===b?'true':'false');});
    document.querySelectorAll('.demo .view').forEach(function(v){v.classList.toggle('on',v.getAttribute('data-view')===b.getAttribute('data-view'));});
  });});
})();
