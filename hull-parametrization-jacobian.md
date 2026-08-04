# Using the Hull Parameterization Through the Jacobian

The key idea is to treat the hull as a parameterized surface and use the **Jacobian as the conversion factor from parameter-space area to projected physical area**.

## 1. Camber's hull parameterization

A hull point is generated from two parameters:

- $u$: position along the hull
- $v$: position down the section

Camber therefore has a map

$$
(u,v) \longmapsto \bigl(x(u,v), y(u,v), z(u,v)\bigr),
$$

where $y$ is the half-breadth.

Michell's integral does not integrate over the three-dimensional hull-surface area. It integrates over the hull's vertical centreplane projection:

$$
\iint_D y(X,Z)e^{K(X,Z)}\,dX\,dZ.
$$

Camber transforms each surface point into hydrodynamic coordinates:

$$
X = x\cos r-z\sin r,
$$

$$
Z = x\sin r+z\cos r+\text{waterline},
$$

where $r$ is the deck rake. This gives the map

$$
(u,v) \longmapsto \bigl(X(u,v), Z(u,v)\bigr),
$$

with $y(u,v)$ carried as the half-breadth at that projected point.

## 2. What the Jacobian represents

Consider a small rectangle in parameter space:

$$
du\,dv.
$$

Its edges become two vectors in the projected $(X,Z)$ plane:

$$
\frac{\partial(X,Z)}{\partial u}\,du
=
\begin{bmatrix}
X_u \\
Z_u
\end{bmatrix}du,
$$

and

$$
\frac{\partial(X,Z)}{\partial v}\,dv
=
\begin{bmatrix}
X_v \\
Z_v
\end{bmatrix}dv.
$$

These vectors form a small parallelogram. Its physical area is

$$
dX\,dZ = |J|\,du\,dv,
$$

where

$$
J
=
\det
\begin{bmatrix}
X_u & X_v \\
Z_u & Z_v
\end{bmatrix}
= X_uZ_v-X_vZ_u.
$$

The original integral can therefore be written as

$$
\iint_D y(X,Z)e^K\,dX\,dZ
=
\iint_\Omega
  y(u,v)e^{K(u,v)}
  \left|X_uZ_v-X_vZ_u\right|
  \,du\,dv.
$$

This is the change-of-variables formula used by `sampleCenterplane()` in [`src/core/michell.ts`](src/core/michell.ts).

## 3. Why this matters for Camber hulls

Camber's station planes **fan as the plan curve turns**. A section is therefore not necessarily contained in a plane of constant longitudinal coordinate $X$.

Consequently,

$$
X_v \ne 0.
$$

Moving down a section can also move the point longitudinally.

A conventional station-by-station integration might approximate the projected area as

$$
dX\,dZ \approx X_uZ_v\,du\,dv.
$$

But that omits the cross-term

$$
-X_vZ_u.
$$

The full Jacobian includes that correction automatically:

$$
J=X_uZ_v-X_vZ_u.
$$

The implementation also uses the true $X(u,v)$ in the wave phase:

$$
e^{i\nu\sec\theta\,X(u,v)}.
$$

Thus both the physical integration area and the longitudinal wave phase account for the station fan.

## 4. How the derivatives are computed

The implementation computes the two derivative directions differently.

### Section direction: $v$

The section curve supplies an exact tangent:

```ts
const [dn, dz] = sec.d(v);
```

That tangent is transformed through the station frame and deck-rake rotation to obtain

$$
X_v,\qquad Z_v.
$$

### Longitudinal direction: $u$

The lofted hull changes through station position, orientation, and section shape. The implementation evaluates nearby surface points at fixed $v$:

```ts
const a0 = hydroAt(model, fr0, sec0, v, cr, sr);
const a1 = hydroAt(model, fr1, sec1, v, cr, sr);

const Xu = (a1.X - a0.X) / du;
const Zu = (a1.Z - a0.Z) / du;
```

It then computes the determinant:

```ts
const J = Xu * Zv - Xv * Zu;
```

## 5. Building a quadrature node

For a Gauss quadrature node, the projected area represented by that node is

$$
\Delta A_{XZ}
=
|J|\,w_u\,w_v\,s^2,
$$

where:

- $w_u$ and $w_v$ are quadrature weights;
- $s$ is metres per model unit;
- $s^2$ converts projected area to square metres.

The Michell node weight is then

$$
W=y\,\Delta A_{XZ}.
$$

In code:

```ts
const aJ = Math.abs(J) * wu * wv * scale * scale;
const y = h.y * scale;
Ws.push(y * aJ);
```

The weight $W$ has units of cubic metres. Therefore,

$$
\sum_i W_i
\approx
\iint_D y\,dX\,dZ,
$$

which is half the hull's displaced volume.

For the wave spectrum, the contribution from the same node becomes

$$
W_i
\exp\!\left(\nu\sec^2\theta\,Z_i\right)
\exp\!\left(i\nu\sec\theta\,X_i\right).
$$

The geometry can therefore be sampled once and reused for every propagation angle $\theta$, provided that the sampling resolution is sufficient for the requested speed.

## 6. This is a projected-area Jacobian

This is **not** the usual three-dimensional hull-surface Jacobian

$$
\left|
\frac{\partial\mathbf r}{\partial u}
\times
\frac{\partial\mathbf r}{\partial v}
\right|,
$$

which would measure wetted surface area.

Instead, it is the two-dimensional projected Jacobian

$$
\left|
\frac{\partial(X,Z)}{\partial(u,v)}
\right|.
$$

That distinction matters because Michell's theory replaces the hull with its centreplane projection and treats $y$ as the half-breadth field over that projection.

## 7. The wetted parameter domain

The complete $(u,v)$ domain is not integrated blindly. For each $u$, `wetSpan()` determines the valid interval

$$
v_{\mathrm{top}}(u)
\le v \le
v_{\mathrm{bottom}}(u),
$$

using the following constraints:

- waterline;
- sheer;
- centreline;
- transom.

Quadrature runs only over this wetted region. The Jacobian therefore transforms the actual trimmed and immersed hull projection, rather than the complete untrimmed design surface.

## Summary

Camber already knows how to map $(u,v)$ to the hull. The Jacobian tells Michell's integral how much physical $(X,Z)$ area each small piece of parameter space represents:

$$
\boxed{
  dX\,dZ
  =
  \left|X_uZ_v-X_vZ_u\right|du\,dv
}
$$

This lets the implementation integrate directly over Camber's native hull parameterization. It avoids section inversion and correctly includes deck rake, loft deformation, and fanned station planes.
