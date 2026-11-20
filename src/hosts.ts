// The MCP SDK compares the Host header exactly, including the port when the
// client sends one. Operators list names or addresses; the listen port is added.
export function allowedHostHeaders(configured:readonly string[],port:number){
 const out=new Set<string>();
 for(const raw of configured){
  const host=raw.trim();
  if(!host)continue;
  out.add(host);
  const hasPort=host.startsWith('[')?host.includes(']:'):host.includes(':');
  if(!hasPort)out.add(`${host}:${port}`);
 }
 return out;
}
export function hostAllowed(header:string|undefined,allowed:ReadonlySet<string>){
 return header!==undefined&&allowed.has(header);
}
