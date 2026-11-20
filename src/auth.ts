import {createHash,timingSafeEqual} from 'node:crypto';
// Hash both sides so a length mismatch does not throw or return early.
export function bearerMatches(provided:string,expected:string){
 const actual=createHash('sha256').update(provided).digest();
 const wanted=createHash('sha256').update(expected).digest();
 return timingSafeEqual(actual,wanted);
}
