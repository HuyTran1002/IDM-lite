// Custom signing bypass script for electron-builder
exports.default = async function(configuration) {
  console.log(`[Bypass Sign] Skipping code signing for file: ${configuration.path}`);
};
