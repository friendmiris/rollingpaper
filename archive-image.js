import {get} from '@vercel/blob';
import {uuidPattern,reply,readArchive,validRecipient,privateHeaders} from './_core.js';
export async function GET(request){
 if(request.method!=='GET')return reply({error:'METHOD_NOT_ALLOWED'},405);
 try{
  const params=new URL(request.url).searchParams;
  const room=params.get('room'),gift=params.get('gift')||'',id=params.get('id');
  if(!uuidPattern.test(room||'')||!/^[a-f0-9]{64}$/.test(id||''))return reply({error:'INVALID_REQUEST'},400);
  const archive=await readArchive(room);
  if(!archive||!validRecipient(archive,gift))return reply({error:'FORBIDDEN'},403);
  const type=archive.images?.[id],ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[type];
  if(!ext)return reply({error:'NOT_FOUND'},404);
  const result=await get(`rolling-archives/v1/${room}/images/${id}.${ext}`,{access:'private'});
  if(!result||result.statusCode!==200)return reply({error:'IMAGE_NOT_FOUND'},404);
  return new Response(result.stream,{headers:{...privateHeaders,'Content-Type':type,'Content-Security-Policy':"default-src 'none'"}});
 }catch(error){console.error('Archive image failed',error);return reply({error:'IMAGE_READ_FAILED'},503)}
}
