function slugify(str) {
  if (typeof str !== 'string') {
    throw new TypeError('slugify: expected a string');
  }

  return str
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export { slugify };
