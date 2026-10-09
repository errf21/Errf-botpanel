/** Tiny DOM for permanent offline script-state tests; real Chromium QA is
 * additionally run outside this dependency-free automated suite. */
export function panelFormDom(){
 const nodes=new Map<string,any>();
 function element(){return {value:'',hidden:false,disabled:false,required:false,checked:false,indeterminate:false,textContent:'',children:[] as any[],attributes:{} as Record<string,string>,append(...v:any[]){this.children.push(...v);},replaceChildren(...v:any[]){this.children=[...v];},setAttribute(k:string,v:string){this.attributes[k]=v;}};}
 function get(id:string):any{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);}
 get('fields').disabled=true;get('fields').hidden=true;get('save').disabled=true;get('group-controls').hidden=true;get('group-warning').hidden=true;get('group-retry').hidden=true;get('f').querySelector=()=>get('save');
 let seq=0;const timers=new Map<number,()=>unknown>();
 return {get,nodes,document:{getElementById:get,createElement:()=>element()},setTimeout:(fn:()=>unknown)=>{const id=++seq;timers.set(id,fn);return id;},clearTimeout:(id:number)=>timers.delete(id),async flush(){for(const [id,f]of timers){timers.delete(id);await f();}},checkboxes:()=>get('group-list').children.map((r:any)=>r.children[0]),names:()=>get('group-list').children.map((r:any)=>r.children[1].textContent)};
}
