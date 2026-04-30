from PIL import Image, ImageDraw
import math

def draw_icon(size, filename):
    img = Image.new('RGB', (size, size), color='#1e293b')
    d = ImageDraw.Draw(img)
    
    # Draw sine wave
    points = []
    for x in range(0, size):
        # Scale x to 0-2PI
        scaled_x = (x / size) * math.pi * 2
        y = (size / 2) - math.sin(scaled_x) * (size / 3)
        points.append((x, y))
        
    d.line(points, fill='#3b82f6', width=max(1, size // 15), joint='curve')
    
    img.save(filename)

draw_icon(192, '/Users/johanhovda/Documents/Lybbølge-Lab/lyd-lab/icon-192.png')
draw_icon(512, '/Users/johanhovda/Documents/Lybbølge-Lab/lyd-lab/icon-512.png')
