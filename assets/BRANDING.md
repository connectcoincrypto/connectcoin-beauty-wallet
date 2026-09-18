# ConnectWallet artwork

The cyan/royal-blue and violet/lilac interlocking mark follows the ConnectCoin
palette supplied by the project owner. `connectwallet-mark.png` is the
transparent master. `icon.svg` places it on the dark rounded tile from that
reference; transparency outside the tile is preserved.

Run `npm run build:icon` to rebuild `icon.png` (1024px), `icon-512.png`, and
`icon.ico` (16, 24, 32, 48, 64, 128, and 256px). The committed master is reused
locally: rebuilding never calls an image service or fetches remote artwork.
The same generated icon is used by the desktop window, installer and renderer.

## Master provenance

Created with the built-in image-generation editor from the user-supplied
ConnectCoin brand sheet. Prompt:

> Use case: background-extraction. Input image: the provided ConnectCoin brand reference sheet. Asset: standalone transparent logo mark for the ConnectWallet desktop wallet. Isolate ONLY the interlocking blue/cyan and violet/lilac symbol shown to the left of the ConnectCoin wordmark and repeated in the square app icons. Preserve that exact two-piece curved silhouette and diagonal orientation: cyan-to-royal-blue top-left hook, purple-to-lilac bottom-right hook, softly rounded glossy forms, clean open center. Produce ONE large centered symbol in a square image with about 8% transparent padding. GENUINELY TRANSPARENT BACKGROUND, including center and gaps. No white background, no square/tile, no floor shadow, no lettering, no wordmark, no tiny decorative sparks, no collage, no additional graphics. Faithfully isolate the reference identity instead of inventing a different logo. Preserve cyan-blue-violet gradients and clean antialiased edges. Output suitable as a high-resolution PNG master used for 16px to 1024px application icons.
