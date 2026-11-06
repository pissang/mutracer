#!/usr/bin/env python3
"""Generate small procedural, redistributable USD fixtures; requires USD Python."""
from pathlib import Path
import struct, zlib
from pxr import Usd, UsdGeom, UsdShade, UsdLux, Sdf, Gf, Vt
ROOT = Path(__file__).resolve().parent

def material(stage, path, mx=True, texture=False):
    m = UsdShade.Material.Define(stage, path)
    s = UsdShade.Shader.Define(stage, path + '/Surface')
    s.CreateIdAttr('ND_open_pbr_surface_surfaceshader' if mx else 'UsdPreviewSurface')
    if mx:
        s.CreateInput('base_color', Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(.4,.15,.05))
        s.CreateInput('coat_weight', Sdf.ValueTypeNames.Float).Set(.25)
        s.CreateInput('emission_luminance', Sdf.ValueTypeNames.Float).Set(.1)
        s.CreateInput('emission_color', Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(.2,.4,.1))
    else:
        s.CreateInput('diffuseColor', Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(.1,.3,.7))
        s.CreateInput('roughness', Sdf.ValueTypeNames.Float).Set(.25)
    if texture:
        image = UsdShade.Shader.Define(stage, path+'/Image')
        image.CreateIdAttr('ND_image_color3' if mx else 'UsdUVTexture')
        image.CreateInput('file', Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath('checker.png'))
        uv = UsdShade.Shader.Define(stage, path+'/UV')
        uv.CreateIdAttr('ND_texcoord_vector2' if mx else 'UsdPrimvarReader_float2')
        if not mx: uv.CreateInput('varname', Sdf.ValueTypeNames.Token).Set('st')
        image.CreateInput('texcoord' if mx else 'st',Sdf.ValueTypeNames.Float2).ConnectToSource(uv.ConnectableAPI(),'out' if mx else 'result')
        s.GetInput('base_color' if mx else 'diffuseColor').ConnectToSource(image.ConnectableAPI(),'out' if mx else 'rgb')
    m.CreateSurfaceOutput('mtlx' if mx else '').ConnectToSource(s.ConnectableAPI(),'out' if mx else 'surface')
    return m

def mesh(stage,path,mat):
    m=UsdGeom.Mesh.Define(stage,path)
    m.CreateSubdivisionSchemeAttr('none')
    m.CreatePointsAttr([(-1,-1,0),(1,-1,0),(1,1,0),(-1,1,0)])
    m.CreateFaceVertexCountsAttr([4]);m.CreateFaceVertexIndicesAttr([0,1,2,3])
    m.CreateNormalsAttr([(0,0,1)]*4);m.SetNormalsInterpolation('vertex')
    m.CreateDoubleSidedAttr(True)
    st=UsdGeom.PrimvarsAPI(m).CreatePrimvar('st',Sdf.ValueTypeNames.TexCoord2fArray,'faceVarying');st.Set([(0,0),(1,0),(1,1),(0,1)])
    UsdShade.MaterialBindingAPI.Apply(m.GetPrim()).Bind(mat)
    return m

for name,kind in [('rect','RectLight'),('sphere','SphereLight'),('distant','DistantLight'),('spot','SphereLight'),('dome','DomeLight'),('disk','DiskLight'),('cylinder','CylinderLight'),('openpbr','RectLight'),('preview','RectLight'),('textured','RectLight'),('orthographic','RectLight'),('dof','RectLight'),('instancer','RectLight'),('nested','RectLight'),('edits','RectLight'),('faces','RectLight'),('alpha-mask','RectLight')]:
    path=ROOT/(name+'.usda')
    stage=Usd.Stage.CreateNew(str(path));UsdGeom.SetStageMetersPerUnit(stage,1);UsdGeom.SetStageUpAxis(stage,'Y')
    mat=material(stage,'/Materials/Open',True,name in ('textured','edits')); preview=material(stage,'/Materials/Preview',False)
    m=mesh(stage,'/Mesh',preview if name in ('preview','alpha-mask') else mat)
    if name=='alpha-mask':
        shader=UsdShade.Shader(stage.GetPrimAtPath('/Materials/Preview/Surface'))
        shader.CreateInput('opacity',Sdf.ValueTypeNames.Float).Set(.2);shader.CreateInput('opacityThreshold',Sdf.ValueTypeNames.Float).Set(.5)
    if name=='faces':
        m.CreatePointsAttr([(-1,-1,0),(0,-1,0),(0,1,0),(-1,1,0),(1,-1,0),(1,1,0)])
        m.CreateFaceVertexCountsAttr([4,4]);m.CreateFaceVertexIndicesAttr([0,1,2,3,1,4,5,2]);m.CreateNormalsAttr([(0,0,1)]*6)
        UsdGeom.PrimvarsAPI(m).GetPrimvar('st').Set([(0,0),(1,0),(1,1),(0,1)]*2)
    if name=='edits':
        other=mesh(stage,'/PreviewMesh',preview);UsdGeom.XformCommonAPI(other).SetTranslate((1.3,0,-.2));UsdGeom.XformCommonAPI(other).SetScale((.4,.4,.4))
    light=getattr(UsdLux,kind).Define(stage,'/Light')
    light.CreateIntensityAttr(2); light.CreateColorAttr(Gf.Vec3f(1))
    UsdGeom.XformCommonAPI(light).SetTranslate((0,0,3))
    if kind=='RectLight': light.CreateWidthAttr(2);light.CreateHeightAttr(2)
    if kind=='SphereLight':light.CreateRadiusAttr(.2)
    if kind=='DistantLight':light.CreateNormalizeAttr(True)
    if name=='spot':
        shaping=UsdLux.ShapingAPI.Apply(light.GetPrim());shaping.CreateShapingConeAngleAttr(35);shaping.CreateShapingConeSoftnessAttr(.25)
    camera=UsdGeom.Camera.Define(stage,'/Camera');UsdGeom.XformCommonAPI(camera).SetTranslate((0,0,5))
    camera.CreateClippingRangeAttr(Gf.Vec2f(.1,100));camera.CreateFocalLengthAttr(50)
    camera.CreateHorizontalApertureAttr(36);camera.CreateVerticalApertureAttr(36)
    if name=='orthographic':camera.CreateProjectionAttr('orthographic');camera.CreateHorizontalApertureAttr(40);camera.CreateVerticalApertureAttr(40)
    if name=='dof':camera.CreateFStopAttr(1.4);camera.CreateFocusDistanceAttr(4)
    if name in ('instancer','nested'):
        # Move the prototype into a non-rendered prototype scope through the
        # relationship; Hydra's USD adapter hides this source automatically.
        inst=UsdGeom.PointInstancer.Define(stage,'/Instances');inst.CreatePrototypesRel().SetTargets(['/Mesh'])
        inst.CreateProtoIndicesAttr([0,0]);inst.CreatePositionsAttr([(-1.2,0,0),(1.2,0,0)]);inst.CreateScalesAttr([(.45,.45,.45)]*2)
        if name=='nested':
            outer=UsdGeom.PointInstancer.Define(stage,'/Outer');outer.CreatePrototypesRel().SetTargets(['/Instances'])
            outer.CreateProtoIndicesAttr([0,0]);outer.CreatePositionsAttr([(0,-.7,0),(0,.7,0)]);outer.CreateScalesAttr([(.7,.7,.7)]*2)
    stage.GetRootLayer().Save()
    path.write_text(path.read_text().rstrip()+"\n")

for name,pixels in [('checker.png',bytes([255,20,0,0,255,20,20,0,255,255,255,255])),('checker-alternate.png',bytes([20,255,255,255,20,255,255,255,20,30,30,30]))]:
    def chunk(kind,data): return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
    data=b'\0'+pixels[:6]+b'\0'+pixels[6:]
    (ROOT/name).write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>2I5B',2,2,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(data))+chunk(b'IEND',b''))
print('generated fixtures in',ROOT)
