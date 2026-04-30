const fs = require('fs');
const code = fs.readFileSync('/Users/johanhovda/.gemini/antigravity/brain/1a44d9b4-0673-4631-b052-daaba389b5a7/.system_generated/steps/195/content.md', 'utf8');
const React = require('react');
const globalObj = { react: React };
const factoryCode = code.split('factory(')[2].split(')')[0];
console.log("Found factory signature");
