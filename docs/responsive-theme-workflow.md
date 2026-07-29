# Redactotron responsive theme workflow

Redactotron uses the same repeatable architecture as the active CareWay Theme,
without copying CareWay product components or flows.

## Canonical modes

| Layout | Verification width | Responsive variable mode |
| --- | ---: | --- |
| Small | 390 px | Small |
| Medium | 1024 px | Medium |
| Full | 1210 px | Full |

The root `RedactotronThemeProvider` resolves the viewport once. Feature
components must consume `useComponentLayout()` or CSS variables; they must not
create local media-query breakpoint logic.

## Component contract

Every reusable Figma component exposes `Layout=Small|Medium|Full`. The matching
React component accepts `layout="small"|"medium"|"full"|"responsive"`.
`responsive` is the default and inherits the root provider. Explicit modes are
for isolated previews, tests, and Code Connect examples.

## Repeatable component workflow

1. Create one semantic React component with a `layout` input.
2. Use `useComponentLayout(layout)`; do not read `window.innerWidth` inside
   the component.
3. Style from the central `--rt-*` variables in `responsive-theme.css`.
4. In Figma, create exactly three Layout variants and bind each variant to the
   corresponding mode in `Redactotron / Responsive`.
5. Verify with `ResponsiveViewPreview` at 390, 1024, and 1210.
6. Add the Figma node-to-source mapping only after all three variants pass.

## Migration rule

Legacy one-size Figma components remain available until their instances have
been swapped to responsive sets and all three mockup shells are visually
verified. Then they can be removed without touching the original CareWay file.
