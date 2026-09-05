const fs = require('fs');

const requiredAssets = [
    'views/pdf-viewer/vendor/build/pdf.js',
    'views/pdf-viewer/vendor/build/pdf.worker.js',
    'views/pdf-viewer/vendor/web/viewer.css',
    'views/pdf-viewer/vendor/web/viewer.html',
    'views/pdf-viewer/vendor/web/viewer.js',
    'data/vendor/languages/latex-language-configuration.json',
    'data/vendor/languages/latex-cpp-embedded-language-configuration.json',
    'data/vendor/languages/markdown-latex-combined-language-configuration.json',
];

const invalidAssets = requiredAssets.filter(asset => {
    try {
        const stat = fs.statSync(asset);
        return !stat.isFile() || stat.size === 0;
    } catch {
        return true;
    }
});
if (invalidAssets.length > 0) {
    console.error(`Missing or empty generated runtime assets:\n${invalidAssets.join('\n')}`);
    console.error('Run npm run postinstall before packaging the extension.');
    process.exit(1);
}
