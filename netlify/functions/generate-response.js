const OpenAI = require("openai");
const { getSupabaseAdmin } = require("./_supabase.js");

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  // Initialize OpenAI client
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    const { summary, recordId = null, tone = 'professional', approach = 'cooperative', style = 'detailed' } = JSON.parse(event.body || "{}");
    if (!summary) return { statusCode: 400, body: JSON.stringify({ error: "Missing summary" }) };

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.8,
      top_p: 0.9,
      messages: [
        { 
          role: "system", 
          content: `You are a certified tax professional and audit response specialist. 

Generate precise, factual IRS audit or CP2000 response letters. Reference the specific notice, explain discrepancies clearly, cite documentation, and maintain a respectful tone requesting case reconsideration.

Write a professional, IRS-compliant response letter with the following specifications:

**TONE: ${tone}**
- Professional & Formal: Use formal language, proper titles, and official terminology
- Conversational & Friendly: Use approachable language while maintaining professionalism
- Assertive & Direct: Be firm and direct in your statements and requests
- Conciliatory & Diplomatic: Use diplomatic language to find common ground

**APPROACH: ${approach}**
- Defensive & Protective: Focus on protecting taxpayer rights and challenging IRS positions
- Cooperative & Collaborative: Work with the IRS to resolve issues amicably
- Challenging & Questioning: Question IRS findings and demand detailed explanations
- Explanatory & Educational: Focus on explaining the taxpayer's position clearly

**WRITING STYLE: ${style}**
- Detailed & Comprehensive: Provide extensive explanations and supporting details
- Concise & To-the-Point: Keep responses brief and focused on key points
- Technical & Legal-Focused: Use legal terminology and cite specific tax laws
- Personal & Relatable: Use personal examples and relatable language

1. **Format & Structure:**
   - Use proper business letter format with date, recipient, and subject line
   - Reference the specific IRS notice number, date, and taxpayer ID
   - Include proper salutation and closing

2. **Content Requirements:**
   - Address each specific issue raised by the IRS
   - Provide clear, factual explanations with supporting details
   - Include relevant tax law references when appropriate
   - Request specific actions or clarifications as needed
   - Offer to provide additional documentation if required

3. **Professional Standards:**
   - Use precise IRS terminology and form references
   - Include appropriate legal disclaimers
   - Follow current IRS response guidelines
   - Ensure all statements are accurate and verifiable

4. **Response Elements:**
   - Acknowledge receipt of the notice
   - State your position clearly and concisely
   - Provide supporting documentation references
   - Request specific relief or clarification
   - Include contact information for follow-up
   - Set reasonable expectations for response time

Write a response that matches the specified tone, approach, and style while protecting the taxpayer's rights and maintaining professional standards.` 
        },
        { 
          role: "user", 
          content: `Based on this IRS letter analysis, write a professional response letter:\n\n${summary}\n\nEnsure the response addresses all issues raised, provides clear explanations, and follows proper IRS correspondence protocols.` 
        }
      ],
    });

    const letter = completion.choices?.[0]?.message?.content?.trim() || "";

    // Update the existing record (if provided)
    if (recordId) {
      const supabase = getSupabaseAdmin();
      const { error } = await supabase
        .from("ara_letters")
        .update({ ai_response: letter, status: "responded" })
        .eq("id", recordId);
      if (error) throw error;
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ letter }),
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
}