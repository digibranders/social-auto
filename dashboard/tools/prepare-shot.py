#!/usr/bin/env python3
"""Turns a raw screenshot into a Help picture: blurs private parts, boxes the thing to click, crops, shrinks.

  python3 tools/prepare-shot.py SRC OUT [--crop x0,y0,x1,y1] [--blur x0,y0,x1,y1 ...]
                                [--box x0,y0,x1,y1[:label] ...] [--width 960]

All coordinates are pixels of the ORIGINAL screenshot. Blurring is a coarse mosaic, so the text underneath
cannot be recovered. Run it with `python3 -I`-style isolation from a clean folder, never from the folder of
untrusted files.
"""
import argparse
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ACCENT = (124, 92, 255)
FONTS = ['/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']


def box(value):
    parts = value.split(':', 1)
    x0, y0, x1, y1 = (int(float(n)) for n in parts[0].split(','))
    return (x0, y0, x1, y1), (parts[1] if len(parts) > 1 else None)


def font(size):
    for path in FONTS:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def mosaic(image, region):
    x0, y0, x1, y1 = region
    part = image.crop(region)
    cell = max(10, (y1 - y0) // 2)
    small = part.resize((max(1, (x1 - x0) // cell), max(1, (y1 - y0) // cell)), Image.BILINEAR)
    image.paste(small.resize(part.size, Image.NEAREST).filter(ImageFilter.GaussianBlur(2)), region)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('src')
    p.add_argument('out')
    p.add_argument('--crop')
    p.add_argument('--blur', action='append', default=[])
    p.add_argument('--box', action='append', default=[])
    p.add_argument('--width', type=int, default=960)
    a = p.parse_args()

    image = Image.open(a.src).convert('RGB')
    for spec in a.blur:
        mosaic(image, box(spec)[0])
    draw = ImageDraw.Draw(image)
    # Size the box and label so they look the same in every picture after the final crop and shrink.
    crop_w = (box(a.crop)[0][2] - box(a.crop)[0][0]) if a.crop else image.width
    zoom = crop_w / min(a.width, crop_w)
    thickness = max(2, round(3 * zoom))
    for spec in a.box:
        (x0, y0, x1, y1), label = box(spec)
        pad = thickness * 2
        draw.rounded_rectangle((x0 - pad, y0 - pad, x1 + pad, y1 + pad), radius=10, outline=ACCENT, width=thickness)
        if label:
            below = label.startswith('_')  # "_text" puts the label under the box instead of above it
            label = label.lstrip('_')
            f = font(round(14 * zoom))
            tw = draw.textlength(label, font=f)
            th = round(f.size * 1.5)
            tx = x1 + pad - tw - 16
            ty = y1 + pad + 2 if below else max(0, y0 - pad - th)
            draw.rounded_rectangle((tx, ty, tx + tw + 16, ty + th), radius=th // 2, fill=ACCENT)
            draw.text((tx + 8, ty + round(f.size * 0.2)), label, font=f, fill=(255, 255, 255))
    if a.crop:
        image = image.crop(box(a.crop)[0])
    if image.width > a.width:
        image = image.resize((a.width, round(image.height * a.width / image.width)), Image.LANCZOS)
    image.save(a.out, 'JPEG', quality=82, optimize=True)
    print(f'{a.out}: {image.width}x{image.height}, {round(len(open(a.out, "rb").read()) / 1024)} KB', file=sys.stderr)


main()
