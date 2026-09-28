import { marked } from 'marked';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, BorderStyle } from 'docx';

document.addEventListener('DOMContentLoaded', () => {
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }

  // Sample Elements
  const sample1 = document.getElementById('sample1');
  const sample2 = document.getElementById('sample2');
  const sample3 = document.getElementById('sample3');

  const wordCount1 = document.getElementById('wordCount1');
  const wordCount2 = document.getElementById('wordCount2');
  const wordCount3 = document.getElementById('wordCount3');

  const analyzeBtn = document.getElementById('analyzeBtn');
  const loader = document.getElementById('loader');
  const loaderStatus = document.getElementById('loaderStatus');
  const resultCard = document.getElementById('resultCard');
  const resultContent = document.getElementById('resultContent');

  const downloadDocxBtn = document.getElementById('downloadDocxBtn');
  const copyPromptBtn = document.getElementById('copyPromptBtn');
  const copyMarkdownBtn = document.getElementById('copyMarkdownBtn');
  const downloadBtn = document.getElementById('downloadBtn');

  let rawMarkdownResult = '';

  // Word Count Helper
  const setupWordCounter = (textarea, badge) => {
    if (!textarea || !badge) return;
    const update = () => {
      const text = textarea.value.trim();
      const count = text ? text.split(/\s+/).filter(Boolean).length : 0;
      badge.textContent = `${count.toLocaleString()} words`;
      if (count >= 300) {
        badge.style.color = '#047857';
        badge.style.borderColor = '#A7F3D0';
      } else if (count > 0) {
        badge.style.color = '#B91C1C';
        badge.style.borderColor = '#FECACA';
      } else {
        badge.style.color = 'var(--purple-secondary)';
        badge.style.borderColor = 'transparent';
      }
    };
    textarea.addEventListener('input', update);
    update();
  };

  setupWordCounter(sample1, wordCount1);
  setupWordCounter(sample2, wordCount2);
  setupWordCounter(sample3, wordCount3);

  // Analyze Handler
  if (analyzeBtn) {
    analyzeBtn.addEventListener('click', async () => {
      const s1 = sample1 ? sample1.value.trim() : '';
      const s2 = sample2 ? sample2.value.trim() : '';
      const s3 = sample3 ? sample3.value.trim() : '';

      if (!s1 && !s2 && !s3) {
        alert('Please paste at least Writing Sample #1 before generating.');
        return;
      }

      analyzeBtn.disabled = true;
      if (loader) loader.style.display = 'flex';
      if (resultCard) resultCard.style.display = 'none';
      if (loaderStatus) loaderStatus.textContent = 'Analyzing prose samples and generating style guide...';

      try {
        const response = await fetch('/api/analyze', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            sample1: s1,
            sample2: s2,
            sample3: s3
          })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to generate style guide');
        }

        rawMarkdownResult = data.result;

        if (resultContent) {
          resultContent.innerHTML = marked.parse(rawMarkdownResult);
        }
        if (resultCard) {
          resultCard.style.display = 'block';
          resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } catch (error) {
        console.error('Error:', error);
        alert('An error occurred while building the style guide: ' + error.message);
      } finally {
        analyzeBtn.disabled = false;
        if (loader) loader.style.display = 'none';
      }
    });
  }

  // Button Feedback Helper
  const showButtonFeedback = (button, successText, originalHTML, iconName = 'check') => {
    button.innerHTML = `<i data-lucide="${iconName}" style="display: inline-block; width: 16px; margin-bottom: -2px; margin-right: 6px;"></i> ${successText}`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    setTimeout(() => {
      button.innerHTML = originalHTML;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }, 2500);
  };

  // Convert Markdown to Word (.docx) Document
  const exportToWordDocument = async (markdown) => {
    const lines = markdown.split('\n');
    const docChildren = [];

    // Add Document Header Title (The Modern Author - TMA Master Design System)
    docChildren.push(
      new Paragraph({
        children: [
          new TextRun({
            text: "THE MODERN AUTHOR",
            bold: true,
            size: 28,
            color: "1C3447",
          }),
          new TextRun({
            text: " | Style Analyst",
            size: 24,
            color: "C9A66B",
          }),
        ],
        spacing: { after: 100 },
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: "Author Style Guide & Prose Analysis",
            bold: true,
            size: 22,
            color: "C9A66B",
          }),
        ],
        spacing: { after: 100 },
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: "AI is the tool. You are the author. The story is yours.",
            italics: true,
            size: 18,
            color: "1C3447",
          }),
        ],
        spacing: { after: 300 },
      })
    );

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('# ')) {
        docChildren.push(
          new Paragraph({
            children: [
              new TextRun({
                text: line.replace('# ', ''),
                bold: true,
                size: 28,
                color: "0D1B2A",
              })
            ],
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 400, after: 200 },
          })
        );
      } else if (line.startsWith('## ')) {
        docChildren.push(
          new Paragraph({
            children: [
              new TextRun({
                text: line.replace('## ', ''),
                bold: true,
                size: 24,
                color: "C9A66B",
              })
            ],
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 300, after: 150 },
          })
        );
      } else if (line.startsWith('### ')) {
        docChildren.push(
          new Paragraph({
            children: [
              new TextRun({
                text: line.replace('### ', ''),
                bold: true,
                size: 20,
                color: "76B6B8",
              })
            ],
            heading: HeadingLevel.HEADING_3,
            spacing: { before: 200, after: 100 },
          })
        );
      } else if (line.startsWith('- ') || line.startsWith('* ')) {
        const itemText = line.substring(2).trim();
        const children = [];

        // Handle **bold prefix** in list items if present
        const boldMatch = itemText.match(/^(\*\*.*?\*\*|\*.*?\*)(.*)/);
        if (boldMatch) {
          const boldPart = boldMatch[1].replace(/\*/g, '');
          const restPart = boldMatch[2];
          children.push(
            new TextRun({ text: boldPart, bold: true }),
            new TextRun({ text: restPart })
          );
        } else {
          children.push(new TextRun({ text: itemText }));
        }

        docChildren.push(
          new Paragraph({
            children,
            bullet: { level: 0 },
            spacing: { after: 80 },
          })
        );
      } else {
        // Normal paragraph text
        docChildren.push(
          new Paragraph({
            children: [new TextRun({ text: line })],
            spacing: { after: 150 },
          })
        );
      }
    }

    const doc = new Document({
      sections: [
        {
          properties: {},
          children: docChildren,
        },
      ],
    });

    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'Author-Style-Guide.docx';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Word Document (.docx) Download Handler
  if (downloadDocxBtn) {
    downloadDocxBtn.addEventListener('click', async () => {
      if (!rawMarkdownResult) return;
      try {
        const originalHTML = downloadDocxBtn.innerHTML;
        downloadDocxBtn.disabled = true;
        await exportToWordDocument(rawMarkdownResult);
        showButtonFeedback(downloadDocxBtn, 'Word Doc Downloaded!', originalHTML, 'check');
      } catch (err) {
        console.error('Failed to generate Word document:', err);
        alert('Failed to generate Word document: ' + err.message);
      } finally {
        downloadDocxBtn.disabled = false;
      }
    });
  }

  // Copy AI System Prompt
  if (copyPromptBtn) {
    copyPromptBtn.addEventListener('click', async () => {
      if (!rawMarkdownResult) return;
      const systemPromptText = `You are an expert ghostwriter and fiction assistant. You MUST write all future prose in accordance with the following author style guide:

--- AUTHOR STYLE GUIDE ---
${rawMarkdownResult}
--- END AUTHOR STYLE GUIDE ---

Instructions:
- Adhere strictly to the Summarized Style Rules (Do's and Avoid's).
- Replicate the author's narrative rhythm, POV distance, cadence, and sentence length.
- NEVER use em dashes. Use periods, commas, or parentheses instead.`;

      try {
        await navigator.clipboard.writeText(systemPromptText);
        showButtonFeedback(copyPromptBtn, 'System Prompt Copied!', copyPromptBtn.innerHTML);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    });
  }

  // Copy Markdown
  if (copyMarkdownBtn) {
    copyMarkdownBtn.addEventListener('click', async () => {
      if (!rawMarkdownResult) return;
      try {
        await navigator.clipboard.writeText(rawMarkdownResult);
        showButtonFeedback(copyMarkdownBtn, 'Markdown Copied!', copyMarkdownBtn.innerHTML);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    });
  }

  // Download Markdown (.md)
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      if (!rawMarkdownResult) return;
      const blob = new Blob([rawMarkdownResult], { type: 'text/markdown;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', 'author-style-guide.md');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    });
  }
});
