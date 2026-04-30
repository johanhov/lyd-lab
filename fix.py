import re

with open('/Users/johanhovda/Documents/Mønsterbygger/mønsteroppgaver.html', 'r', encoding='utf-8') as f:
    orig = f.read()

idx = orig.find('// --- RENDER HOVEDAPP ---')
if idx != -1:
    content_to_restore = orig[idx:]
    # Remove the generic return from my hello world
    with open('/Users/johanhovda/Documents/monsteroppgaver.html', 'r', encoding='utf-8') as f:
        broken = f.read()
    
    broken_idx = broken.find('// --- RENDER HOVEDAPP ---')
    if broken_idx != -1:
        # replace everything from broken_idx to the end of the script tag
        end_script_idx = broken.find('</script>', broken_idx)
        
        # content_to_restore includes the end of the App component.
        # But orig was just raw React code, so it doesn't have root.render()
        
        new_content = broken[:broken_idx] + content_to_restore + """
// Render the app
const root = createRoot(document.getElementById('root'));
root.render(<App />);

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(registration => {
      console.log('ServiceWorker registration successful with scope: ', registration.scope);
    }).catch(err => {
      console.log('ServiceWorker registration failed: ', err);
    });
  });
}
""" + broken[end_script_idx:]

        with open('/Users/johanhovda/Documents/monsteroppgaver.html', 'w', encoding='utf-8') as f:
            f.write(new_content)
        print("Restored!")
