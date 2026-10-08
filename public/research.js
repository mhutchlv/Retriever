// Moved from an inline <script> so the page runs under a strict script policy.
(function(){
  /* dollars vs errors */
  var ns='http://www.w3.org/2000/svg',g=document.getElementById('sq');
  var rects=[];
  for(var i=0;i<20;i++){var r=document.createElementNS(ns,'rect');r.setAttribute('rx','3');g.appendChild(r);rects.push(r);}
  var big=document.createElementNS(ns,'text');big.setAttribute('x','400');big.setAttribute('y','130');big.setAttribute('text-anchor','middle');big.setAttribute('font-family','IBM Plex Sans, sans-serif');big.setAttribute('font-size','14');big.setAttribute('font-weight','600');big.setAttribute('fill','#15191F');big.setAttribute('class','lbl');big.style.opacity=0;
  var t1=document.createElementNS(ns,'tspan');t1.setAttribute('x','400');t1.textContent='One missed uninsured';var t2=document.createElementNS(ns,'tspan');t2.setAttribute('x','400');t2.setAttribute('dy','18');t2.textContent='subcontractor';big.appendChild(t1);big.appendChild(t2);g.appendChild(big);
  var la=document.getElementById('lbl-a'),lb=document.getElementById('lbl-b');
  function layout(mode){
    rects.forEach(function(r,i){
      if(mode==='errors'){var col=i%10,row=Math.floor(i/10);r.setAttribute('x',16+col*52);r.setAttribute('y',40+row*52);r.setAttribute('width',44);r.setAttribute('height',44);r.setAttribute('fill','#C9C4B9');r.setAttribute('stroke','none');}
      else if(i<19){r.setAttribute('x',16+(i%10)*26);r.setAttribute('y',40+Math.floor(i/10)*26);r.setAttribute('width',16);r.setAttribute('height',16);r.setAttribute('fill','#C9C4B9');r.setAttribute('stroke','none');}
      else {r.setAttribute('x',300);r.setAttribute('y',30);r.setAttribute('width',200);r.setAttribute('height',200);r.setAttribute('fill','#A9481F');r.setAttribute('fill-opacity','0.16');r.setAttribute('stroke','#A9481F');r.setAttribute('stroke-width','2');}
    });
    big.style.opacity=mode==='dollars'?1:0;
    la.textContent=mode==='errors'?'20 corrections. Each box is one audit the system got wrong.':'The same 20 corrections, sized by premium at stake.';
    lb.textContent=mode==='errors'?'Counted this way, they all look the same.':'Right 19 times out of 20, and still wrong on most of the money.';
  }
  layout('errors');
  document.querySelectorAll('.toggle button').forEach(function(b){b.addEventListener('click',function(){
    document.querySelectorAll('.toggle button').forEach(function(x){x.setAttribute('aria-pressed',x===b?'true':'false');});layout(b.getAttribute('data-mode'));
  });});

  /* risk budget */
  var a=document.getElementById('alpha');
  function budget(){var pct=+a.value;document.getElementById('alphaV').textContent=pct+'%';var n=Math.ceil(100/pct)-1;document.getElementById('nmin').textContent=n;var m=n/10;document.getElementById('example').textContent='~'+(m<1?'1 month':Math.round(m)+' months');}
  a.addEventListener('input',budget);budget();
  /* loop animation */
  var loop=document.getElementById('loop');
  window.pennyOnView('#loop',function(el){if(!window.pennyReduced)el.classList.add('go');},0.4);
  document.getElementById('replay').addEventListener('click',function(){loop.classList.remove('go');void loop.offsetWidth;loop.classList.add('go');});
})();
