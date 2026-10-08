import sharp from 'sharp';
import { HttpError } from './http';
import { record } from '../src/domain/validation';
import { workerEnvelope } from './workerProtocol';
import { beginWorkerUsage } from './workerUsage';
import { IMAGE_MAX_BYTES, IMAGE_MAX_PIXELS, type ImageMime, type ImageVariantSpec } from './imageProcessing';

sharp.cache(false);
sharp.concurrency(1);
process.once('disconnect',()=>process.exit(1));
process.once('message',(raw:unknown)=>{
  const usage=beginWorkerUsage();
  void (async()=>{
    const input=workerEnvelope(raw);
    if(typeof input.bytes!=='string'||input.bytes.length>Math.ceil(IMAGE_MAX_BYTES/3)*4||!input.bytes.length||input.bytes.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.bytes)||!['image/png','image/jpeg','image/webp','image/gif'].includes(String(input.mime)))throw new HttpError(400,'IMAGE_TYPE','Invalid image input');
    const bytes=Buffer.from(input.bytes,'base64');if(bytes.length>IMAGE_MAX_BYTES||bytes.toString('base64')!==input.bytes)throw new HttpError(400,'IMAGE_LIMIT','Invalid image size');
    const options={animated:true,failOn:'warning' as const,limitInputPixels:IMAGE_MAX_PIXELS,limitInputChannels:4,unlimited:false,sequentialRead:true};
    let variant:ImageVariantSpec|undefined;
    if(input.variant!==undefined){const spec=record(input.variant);if(typeof spec.width!=='number'||!Number.isSafeInteger(spec.width)||spec.width<1||spec.width>16000||typeof spec.height!=='number'||!Number.isSafeInteger(spec.height)||spec.height<1||spec.height>16000||!['png','webp'].includes(String(spec.format)))throw new HttpError(400,'IMAGE_VARIANT','Invalid image variant');variant={width:spec.width,height:spec.height,format:spec.format as ImageVariantSpec['format']};}
    const metadata=await sharp(bytes,options).timeout({seconds:5}).metadata(),format=metadata.format,mime=`image/${format==='jpeg'?'jpeg':format}` as ImageMime,width=metadata.width??0,height=metadata.pageHeight??metadata.height??0,frames=metadata.pages??1;
    if(!['png','jpeg','webp','gif'].includes(String(format))||mime!==input.mime)throw new HttpError(400,'IMAGE_TYPE','Image MIME mismatch');
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||!Number.isSafeInteger(frames)||width<1||height<1||width>16000||height>16000||frames<1||frames>128||width*height*frames>IMAGE_MAX_PIXELS)throw new HttpError(400,'IMAGE_SIZE','Image pixel limit');
    // Decode every frame, including data beyond an otherwise valid header.
    const decoded=await sharp(bytes,options).timeout({seconds:5}).toColourspace('srgb').raw().toBuffer({resolveWithObject:true});
    if(decoded.info.width!==width||decoded.info.height!==height*frames||decoded.info.channels<1||decoded.info.channels>4||decoded.data.length!==width*height*frames*decoded.info.channels)throw new HttpError(400,'IMAGE_DECODE','Image decode mismatch');
    if(!variant)return{mime,width,height,frames,decodedPixels:width*height*frames,decoder:`sharp-${sharp.versions.sharp}`,metadataStripped:false};
    if(variant.width>width||variant.height>height)throw new HttpError(400,'IMAGE_VARIANT','Image variants cannot enlarge the source');
    // First-frame variants are static. Defaults strip EXIF/XMP/ICC; original bytes remain untouched.
    let resized=sharp(bytes,{...options,animated:false,pages:1}).timeout({seconds:5}).rotate().resize({width:variant.width,height:variant.height,fit:'inside',withoutEnlargement:true});
    resized=variant.format==='png'?resized.png():resized.webp({quality:80});
    const output=await resized.toBuffer({resolveWithObject:true});
    if(output.data.length>IMAGE_MAX_BYTES)throw new HttpError(400,'IMAGE_LIMIT','Image variant exceeds byte limit');
    return{mime:`image/${variant.format}`,width:output.info.width,height:output.info.height,frames:1,decodedPixels:output.info.width*output.info.height,decoder:`sharp-${sharp.versions.sharp}`,metadataStripped:true,data:output.data.toString('base64')};
  })().then(result=>process.send?.({protocol:1,type:'result',result,usage:usage.finish()},()=>process.exit(0))).catch((error:unknown)=>process.send?.({protocol:1,type:'error',code:error instanceof HttpError?error.code:'IMAGE_DECODE',usage:usage.finish()},()=>process.exit(1)));
});
