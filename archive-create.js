import {requireConfig,uuidPattern,reply,hash,readArchive,saveArchive,supabasePaper,supabaseRows,extractImageData,fetchRemoteImages,imageUpload,validateExistingGift,supabaseHeaders} from './_core.js';

export async function POST(request){
 if(request.method!=='POST')return reply({error:'METHOD_NOT_ALLOWED'},405);
 try{
  requireConfig();
  const {roomId,adminPin,giftUrl,expectedLetters,expectedImageReferences}=await request.json();
  if(!uuidPattern.test(roomId||'')||typeof giftUrl!=='string'||giftUrl.length>3000)return reply({error:'INVALID_REQUEST'},400);
  let url;try{url=new URL(giftUrl)}catch{return reply({error:'INVALID_GIFT_URL'},400)}
  if(url.protocol!=='https:'||url.hostname!=='rollingpaper-sandy.vercel.app'||url.searchParams.get('room')!==roomId||url.searchParams.get('mode')!=='gift'||!url.searchParams.get('gift'))return reply({error:'GIFT_LINK_MUST_MATCH_THIS_SITE'},400);
  const gift=url.searchParams.get('gift');if(gift.length<16||gift.length>1024)return reply({error:'INVALID_GIFT_TOKEN'},400);
  const old=await supabasePaper('rolling_papers',roomId);
  const stage=old?null:await supabasePaper('rp_stage_papers',roomId);
  const paper=old||stage;if(!paper)return reply({error:'PAPER_NOT_FOUND'},404);
  // Old papers created without an administrator password cannot pass an admin check.
  // A previously issued, server-verified gift token is sufficient for those legacy papers.
  // Papers with an administrator password continue to require the existing local admin pin.
  const needsAdmin=!!(old?old.admin_password_hash:stage.admin_hash);
  if(needsAdmin){
   if(typeof adminPin!=='string'||adminPin.length<4)return reply({error:'ADMIN_AUTH_REQUIRED'},403);
   const adminRpc=old?'rolling_admin_check':'rp_stage_admin_check';
   const adminRes=await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${adminRpc}`,{
    method:'POST',headers:{'Content-Type':'application/json',...supabaseHeaders()},
    body:JSON.stringify({p_room:roomId,p_admin:adminPin}),cache:'no-store'});
   if(!adminRes.ok||(await adminRes.json())!==true)return reply({error:'ADMIN_AUTH_REQUIRED'},403);
  }
  const verified=await validateExistingGift({roomId,gift,isLegacy:!!old});
  // Only archive letters the existing recipient link is allowed to read.
  // The stage table can contain private or excluded letters; never leak them to a gift link.
  const rawLetters=await supabaseRows(old?'rolling_letters':'rp_stage_letters',roomId);
  const allowedIds=new Set(verified.letters.map(letter=>String(letter.id)));
  const letters=rawLetters.filter(letter=>allowedIds.has(String(letter.id)));
  if(letters.length!==allowedIds.size)throw new Error('VERIFIED_LETTERS_NOT_FOUND');
  if(Number.isSafeInteger(expectedLetters)&&expectedLetters!==letters.length)return reply({error:'LETTER_COUNT_MISMATCH_RELOAD_AND_RETRY'},409);
  const shared=(await supabaseRows('rolling_shared_decor',roomId))[0];
  const raw={
   paper:{id:roomId,title:paper.title,description:paper.description,layout:paper.layout,has_password:!!(paper.read_password_hash||paper.read_hash),gift_verified:true},
   letters:letters.map(x=>({id:x.id,name:x.name,message:x.message,color:x.color,photo:x.photo||'',visibility:x.visibility||'all',created_at:x.created_at})),
   decor:shared?.data||{},
  };
  const serverImageReferences=(JSON.stringify(raw).match(/data:image\//g)||[]).length;
  if(Number.isSafeInteger(expectedImageReferences)&&serverImageReferences<expectedImageReferences)return reply({error:'PHOTO_COUNT_MISMATCH_RETRY_AFTER_SYNC'},409);
  const {data,images,remoteImages}=extractImageData(raw);
  await fetchRemoteImages(remoteImages,images);
  // Never replace any existing archive until every photo has been copied successfully.
  await imageUpload(roomId,images);
  const previous=await readArchive(roomId);
  if(previous && (letters.length<previous.counts.letters||images.size<previous.counts.images))
    return reply({error:'ARCHIVE_SHRINK_BLOCKED_PRESERVE_OLDER_COPY'},409);
  const tokenHashes=Array.from(new Set([...(previous?.tokenHashes||[]),hash(gift)]));
  const archive={version:1,archivedAt:new Date().toISOString(),paperId:roomId,tokenHashes,data,images:Object.fromEntries([...images].map(([id,x])=>[id,x.type])),counts:{letters:letters.length,images:images.size}};
  await saveArchive(roomId,archive);
  const check=await readArchive(roomId);
  if(!check||check.counts.letters!==letters.length||check.counts.images!==images.size||check.data?.paper?.id!==roomId||check.data?.letters?.length!==letters.length||!check.tokenHashes.includes(hash(gift)))throw new Error('VERIFY_FAILED');
  return reply({ok:true,archivedAt:archive.archivedAt,counts:archive.counts,existingLinkPreserved:true});
 }catch(error){console.error('Archive creation failed',error);return reply({error:'ARCHIVE_CREATE_FAILED',detail:String(error.message||error)},500)}
}
