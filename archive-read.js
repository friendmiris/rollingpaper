import {uuidPattern,reply,readArchive,validRecipient,restoreImageUrls,privateHeaders} from './_core.js';
export async function GET(request){
 if(request.method!=='GET')return reply({error:'METHOD_NOT_ALLOWED'},405);
 try{
  const url=new URL(request.url),id=url.searchParams.get('room'),gift=url.searchParams.get('gift')||'';
  if(!uuidPattern.test(id||''))return reply({error:'INVALID_REQUEST'},400);
  const archive=await readArchive(id);
  if(!archive)return reply({error:'NOT_ARCHIVED'},404);
  if(!validRecipient(archive,gift))return reply({error:'INVALID_GIFT'},403);
  return reply({...restoreImageUrls(archive.data,id,gift),isArchived:true,archivedAt:archive.archivedAt,counts:archive.counts});
 }catch(error){console.error('Archive read failed',error);return reply({error:'ARCHIVE_READ_FAILED'},503)}
}
