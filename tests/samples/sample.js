// sample.js - synthetic JavaScript file for Explorer preview testing

/**
 * Returns a greeting string. Used only to give the syntax-highlighted
 * preview something real to render (functions, comments, template strings).
 */
function greet(name) {
  return `Hello, ${name}! This is Explorer's JS preview sample.`;
}

const items = ["Apple", "Banana", "Grape"];

items.forEach((item, i) => {
  console.log(`${i + 1}. ${item}`);
});

console.log(greet("Explorer"));
