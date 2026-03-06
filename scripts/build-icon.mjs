import sharp from "sharp";

await sharp("icon.svg").resize(128, 128).png().toFile("icon.png");
