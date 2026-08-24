// ── Cloudinary Upload ─────────────────────────────────────────────────
const CLOUDINARY_CLOUD_NAME = "dqgcrni5w";
const CLOUDINARY_UPLOAD_PRESET = "umlrklxe";

async function uploadToCloudinary(file) {
    const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

    const response = await fetch(url, { method: "POST", body: formData });

    if (!response.ok) {
        throw new Error(`Cloudinary upload failed (${response.status})`);
    }

    const data = await response.json();
    return {
        url: data.secure_url,
    };
}