const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // Parse the multipart form data
    const contentType = event.headers['content-type'] || event.headers['Content-Type'];
    
    if (!contentType || !contentType.includes('multipart/form-data')) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Content-Type must be multipart/form-data' }) };
    }

    // Extract boundary
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No boundary found in Content-Type' }) };
    }

    // Decode body
    const body = event.isBase64Encoded 
      ? Buffer.from(event.body, 'base64') 
      : Buffer.from(event.body);

    // Parse multipart data
    const parts = parseMultipart(body, boundary);
    
    const userId = parts.find(p => p.name === 'userId')?.value;
    const fileExt = parts.find(p => p.name === 'fileExt')?.value;
    const filePart = parts.find(p => p.name === 'file');

    if (!userId || !filePart || !fileExt) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: 'Missing required fields: userId, fileExt, file' }) 
      };
    }

    // Validate file type
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg', 'image/bmp'];
    if (filePart.contentType && !allowedTypes.includes(filePart.contentType)) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: 'File type not allowed' }) 
      };
    }

    // Validate file size (5MB max)
    if (filePart.data.length > 5 * 1024 * 1024) {
      return { 
        statusCode: 400, 
        headers, 
        body: JSON.stringify({ error: 'File too large (max 5MB)' }) 
      };
    }

    // Create Supabase client with SERVICE_ROLE key (bypasses RLS)
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const filePath = `${userId}/license.${fileExt}`;

    // Upload file using service_role (bypasses RLS!)
    const { error: uploadError } = await supabase.storage
      .from('licenses')
      .upload(filePath, filePart.data, {
        upsert: true,
        contentType: filePart.contentType || 'application/octet-stream'
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      return { 
        statusCode: 500, 
        headers, 
        body: JSON.stringify({ error: 'Upload failed: ' + uploadError.message }) 
      };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('licenses')
      .getPublicUrl(filePath);

    const publicUrl = urlData.publicUrl;

    // Update profile with license URL
    const { error: updateError } = await supabase
      .from('profiles')
      .upsert({ 
        id: userId,
        license_file_url: publicUrl,
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });

    if (updateError) {
      console.error('Profile update error:', updateError);
      // Don't fail - file was uploaded successfully
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        url: publicUrl,
        message: 'License uploaded successfully' 
      })
    };

  } catch (err) {
    console.error('Server error:', err);
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ error: 'Server error: ' + err.message }) 
    };
  }
};

// Simple multipart parser
function parseMultipart(body, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const endBoundary = Buffer.from(`--${boundary}--`);
  
  let start = indexOf(body, boundaryBuffer, 0);
  if (start === -1) return parts;
  
  start += boundaryBuffer.length + 2; // skip boundary + \r\n

  while (start < body.length) {
    const end = indexOf(body, boundaryBuffer, start);
    if (end === -1) break;

    const partData = body.slice(start, end - 2); // -2 for \r\n before boundary
    const headerEnd = indexOf(partData, Buffer.from('\r\n\r\n'), 0);
    
    if (headerEnd === -1) {
      start = end + boundaryBuffer.length + 2;
      continue;
    }

    const headerStr = partData.slice(0, headerEnd).toString('utf8');
    const content = partData.slice(headerEnd + 4);

    // Parse headers
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const contentTypeMatch = headerStr.match(/Content-Type:\s*(.+)/i);

    if (nameMatch) {
      if (filenameMatch) {
        // File part
        parts.push({
          name: nameMatch[1],
          filename: filenameMatch[1],
          contentType: contentTypeMatch ? contentTypeMatch[1].trim() : null,
          data: content
        });
      } else {
        // Text field
        parts.push({
          name: nameMatch[1],
          value: content.toString('utf8').trim()
        });
      }
    }

    start = end + boundaryBuffer.length + 2;
  }

  return parts;
}

function indexOf(buf, search, from) {
  for (let i = from; i <= buf.length - search.length; i++) {
    let found = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) {
        found = false;
        break;
      }
    }
    if (found) return i;
  }
  return -1;
}
