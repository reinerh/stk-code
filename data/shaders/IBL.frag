uniform sampler2D ntex;
uniform sampler2D dtex;
uniform sampler2D albedo;

#ifdef GL_ES
layout (location = 0) out vec4 Diff;
layout (location = 1) out vec4 Spec;
#else
out vec4 Diff;
out vec4 Spec;
#endif

#stk_include "utils/decodeNormal.frag"
#stk_include "utils/getPosFromUVDepth.frag"
#stk_include "utils/DiffuseIBL.frag"
#stk_include "utils/SpecularIBL.frag"


vec3 getXcYcZc(int x, int y, float zC)
{
    // We use perspective symetric projection matrix hence P(0,2) = P(1, 2) = 0
    float xC= (2. * (float(x)) / u_screen.x - 1.) * zC / u_projection_matrix[0][0];
    float yC= (2. * (float(y)) / u_screen.y - 1.) * zC / u_projection_matrix[1][1];
    return vec3(xC, yC, zC);
}

float makeLinear(float f, float n, float z)
{
    return (2 * n) / (f + n - z * (f - n));
}

vec3 fastBlur(vec2 uv)
{
    vec4 sum = vec4(0.0);
    float X = uv.x;
    float Y = uv.y;
    vec2 pixel = vec2(0.001);
/*
    sum += textureLod(albedo, vec2(X, Y - 3.0 * pixel.y),    1.0) * 0.03125;
    sum += textureLod(albedo, vec2(X, Y - 1.3333 * pixel.y), 1.0) * 0.328125;
    sum += textureLod(albedo, vec2(X, Y),                    1.0) * 0.273438;
    sum += textureLod(albedo, vec2(X, Y + 1.3333 * pixel.y), 1.0) * 0.328125;
    sum += textureLod(albedo, vec2(X, Y + 3.0 * pixel.y),    1.0) * 0.03125;*/

    sum += textureLod(albedo, vec2(X - 3.0 * pixel.x, Y),    1.0) * 0.03125;
    sum += textureLod(albedo, vec2(X - 1.3333 * pixel.x, Y), 1.0) * 0.328125;
    sum += textureLod(albedo, vec2(X, Y),                    1.0) * 0.273438;
    sum += textureLod(albedo, vec2(X + 1.3333 * pixel.x, Y), 1.0) * 0.328125;
    sum += textureLod(albedo, vec2(X + 3.0 * pixel.x, Y),    1.0) * 0.03125;

    return sum.rgb;
}


vec3 CalcViewPositionFromDepth(in vec2 TexCoord, in sampler2D DepthMap)
{
    // Combine UV & depth into XY & Z (NDC)
    float z = makeLinear(1000.0, 0.01, textureLod(DepthMap, TexCoord, 0.).x);
    vec3 rawPosition                = vec3(TexCoord, z);

    // Convert from (0, 1) range to (-1, 1)
    vec4 ScreenSpacePosition        = vec4( rawPosition * 2 - 1, 1);

    // Undo Perspective transformation to bring into view space
    vec4 ViewPosition               = u_inverse_projection_matrix * ScreenSpacePosition;

    // Perform perspective divide and return
    return                          ViewPosition.xyz / ViewPosition.w;
}


vec3 RayCast(vec3 dir, inout vec3 hitCoord, out float dDepth, in sampler2D DepthMap, in vec3 fallback)
{
    dir *= 0.25f;

    for(int i = 0; i < 10; ++i) {
        hitCoord               += dir;

        vec4 projectedCoord     = u_projection_matrix * vec4(hitCoord, 1.0);
        projectedCoord.xy      /= projectedCoord.w;
        projectedCoord.xy       = projectedCoord.xy * 0.5 + 0.5;

        float depth             = CalcViewPositionFromDepth(projectedCoord.xy, DepthMap).z;
        dDepth                  = hitCoord.z - depth;

        if(dDepth < 0.0)
        {
            if ((projectedCoord.x > 0.0 && projectedCoord.x < 1.0) && (projectedCoord.y > 0.0 && projectedCoord.y < 1.0))
            {
                // Mix with fallback (black area should be dark anyway)
                vec3 finalColor = textureLod(albedo, projectedCoord.xy, 1.0).rgb;
                finalColor = fastBlur(projectedCoord.xy);
                if ((finalColor.r + finalColor.g + finalColor.b) > 0.)
                {
                    vec2 inside = (gl_FragCoord.xy / u_screen) - 0.5;
                    float vignette = 1. - dot(inside, inside) * 3;
                    vignette = clamp(pow(vignette, 10.0), 0., 0.2);
                    return mix(fallback, finalColor, vignette);
                }
                else
                {
                    return fallback;
                }
            }
            else
            {
                return fallback;
            }
        }
    }

    return fallback;
}






// Main ===================================================================

void main(void)
{
    vec2 uv = gl_FragCoord.xy / u_screen;
    vec3 normal = normalize(DecodeNormal(2. * texture(ntex, uv).xy - 1.));

    Diff = vec4(0.25 * DiffuseIBL(normal), 1.);

    float z = texture(dtex, uv).x;

    vec4 xpos = getPosFromUVDepth(vec3(uv, z), u_inverse_projection_matrix);
    vec3 eyedir = -normalize(xpos.xyz);
    // Extract roughness
    float specval = texture(ntex, uv).z;

    Spec = vec4(.25 * SpecularIBL(normal, eyedir, specval), 1.);

    // Compute Space Screen Reflection =========================================================

    float lineardepth = textureLod(dtex, uv, 0.).x;
    int x = int(gl_FragCoord.x), y = int(gl_FragCoord.y);
    vec3 FragPos = getXcYcZc(x, y, lineardepth);

    // Better implementation: :::::::::::::::::::::::::::::::::::

    float View_Depth            = makeLinear(1000.0, 0.001, lineardepth);
    vec3 ScreenPos              = xpos.xyz;
    vec4 View_Pos               = u_inverse_projection_matrix * vec4(ScreenPos, 1.0f);
         View_Pos              /= View_Pos.w;

    // Reflection vector
    vec3 reflected              = normalize(reflect(eyedir, normal));

    // Ray cast
    vec3 hitPos                 = View_Pos.xyz;
    float dDepth;
    float minRayStep            = 100.0f;
    // Fallback
    vec3 fallback = .25 * SpecularIBL(normal, eyedir, specval);
    vec3 outColor = RayCast(reflected * max(minRayStep, -View_Pos.z), hitPos, dDepth, dtex, fallback);


    Spec = vec4(outColor.rgb, 1.0);

    //Diff = vec4(red, green, blue, 1.0);

    //Diff = vec4(reflection.rgb, 1.0);

}
