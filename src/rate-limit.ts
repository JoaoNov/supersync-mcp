export function createRateLimiter(max:number,windowMs:number,now:()=>number=Date.now){
 const buckets=new Map<string,{reset:number;count:number}>();
 return function allow(key:string){
  const time=now();
  let bucket=buckets.get(key);
  if(!bucket||time>=bucket.reset){
   bucket={reset:time+windowMs,count:0};
   buckets.set(key,bucket);
   if(buckets.size>10_000)for(const [name,value] of buckets)if(time>=value.reset)buckets.delete(name);
  }
  if(bucket.count>=max)return {ok:false as const,retryAfter:Math.max(1,Math.ceil((bucket.reset-time)/1000))};
  bucket.count++;
  return {ok:true as const,retryAfter:0};
 };
}
