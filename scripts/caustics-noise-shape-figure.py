# Linear display-space images; identical sRGB transform for every panel.
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import numpy as np
import sys
E=Path(sys.argv[1]);name,mode,samples=sys.argv[2:5]
baselineRoot=Path(sys.argv[5]) if len(sys.argv)>5 else E
candidateStem=Path(sys.argv[6]) if len(sys.argv)>6 else None
font=ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',18)
# Entire upper back wall plus ceiling, with an enlarged left-wall patch below.
out=Image.new('RGB',(1440,560),(22,22,22));draw=ImageDraw.Draw(out)
for row,(label,directory,kind,count) in enumerate([('PM baseline','baseline','photon','64'),('LT + PM baseline','baseline','light-photon','64'),(name,name,mode,samples)]):
 for col,denoised in enumerate([False,True]):
  folder=(baselineRoot if row<2 else E)/directory
  file=folder/f'cornell-960x544-{kind}-{count}-oidn.f32' if denoised else folder/f'{kind}-display.f32'
  if row==2 and denoised and candidateStem is not None:file=Path(str(candidateStem)+'-oidn.f32')
  if not file.exists():continue
  a=np.fromfile(file,np.float32).reshape(544,960,4)[:,:,:3]
  a=np.where(a<=.0031308,12.92*a,1.055*np.maximum(a,0)**(1/2.4)-.055)
  im=Image.fromarray(np.uint8(np.clip(a,0,1)*255))
  x=row*480+col*240
  out.paste(im.crop((265,2,695,134)).resize((240,132)),(x,38))
  out.paste(im.crop((282,70,378,98)).resize((240,140)),(x,195))
  # Water-covered back wall and floor, shown separately because LT cannot help.
  out.paste(im.crop((425,212,665,340)).resize((240,128)),(x,350))
  out.paste(im.crop((420,518,548,531)).resize((240,52)),(x,498))
  draw.text((x+5,5),label+(' OIDN' if denoised else ' raw'),font=font,fill='white')
# Baseline raw displays are stored per mode to avoid accidental reuse.
out.save(E/name/'comparison.png')
