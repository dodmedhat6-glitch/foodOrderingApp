const path = require('path');

/**
 * Sources are compiled with NodeNext, so they import sibling modules with a
 * '.js' specifier that actually resolves to a '.ts' file. Strip the extension
 * for our own sources only, and leave node_modules (whose '.js' files are real)
 * to the default resolver.
 */
module.exports = (request, options) => {
  const fromNodeModules = options.basedir.includes(`${path.sep}node_modules${path.sep}`);
  if (!fromNodeModules && /^\.{1,2}\/.*\.js$/.test(request)) {
    try {
      return options.defaultResolver(request.replace(/\.js$/, ''), options);
    } catch {
      // fall through to the original specifier
    }
  }
  return options.defaultResolver(request, options);
};
