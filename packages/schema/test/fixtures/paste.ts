/** Clipboard HTML as Google Docs and Word put it on the clipboard (trimmed, structure kept). */
export const GOOGLE_DOCS = [
  '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-0f1e2d3c-7fff-1a2b-3c4d-5e6f7a8b9c0d">',
  '<h1 dir="ltr" style="line-height:1.38;margin-top:20pt;margin-bottom:6pt;"><span style="font-size:20pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Event registration</span></h1>',
  '<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;">Plain, </span>',
  '<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:700;">bold</span>',
  '<span style="font-size:11pt;color:#000000;font-weight:400;">, </span><span style="font-size:11pt;color:#000000;font-weight:400;font-style:italic;">italic</span>',
  '<span style="font-size:11pt;color:#000000;font-weight:400;">, </span><span style="font-size:11pt;color:#000000;font-weight:400;text-decoration:underline;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;">underlined</span>',
  '<span style="font-size:11pt;color:#000000;font-weight:400;">, </span><span style="font-size:11pt;color:#ff0000;background-color:#ffff00;font-weight:400;text-decoration:line-through;">struck in red</span>',
  '<span style="font-size:11pt;color:#000000;font-weight:400;"> and a </span><a href="https://example.com/terms" style="text-decoration:none;"><span style="font-size:11pt;color:#1155cc;font-weight:400;text-decoration:underline;">link</span></a>',
  '<span style="font-size:11pt;color:#000000;font-weight:400;">.</span></p>',
  '<ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;">',
  '<li dir="ltr" style="list-style-type:disc;font-size:11pt;" aria-level="1"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;" role="presentation"><span style="font-size:11pt;font-weight:400;">First</span></p></li>',
  '<li dir="ltr" style="list-style-type:disc;font-size:11pt;" aria-level="1"><p dir="ltr" role="presentation"><span style="font-size:11pt;font-weight:700;">Second</span></p></li>',
  '</ul>',
  '<ol style="margin-top:0;margin-bottom:0;"><li dir="ltr" style="list-style-type:decimal;" aria-level="1"><p dir="ltr" role="presentation"><span style="font-weight:400;">One</span></p></li></ol>',
  '<img src="https://lh7-us.googleusercontent.com/x" width="100" height="50" onerror="alert(1)">',
  '</b><br class="Apple-interchange-newline">',
].join('');

export const WORD = [
  '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta name=Generator content="Microsoft Word 15"><style><!-- p.MsoNormal {margin:0cm;} --></style><!--[if gte mso 9]><xml><o:OfficeDocumentSettings></o:OfficeDocumentSettings></xml><![endif]--></head>',
  '<body lang=EN-IN style=\'tab-interval:36.0pt\'><!--StartFragment-->',
  '<h2 style=\'mso-outline-level:2\'><span lang=EN-US>Heading in Word</span></h2>',
  '<p class=MsoNormal><b><span lang=EN-US style=\'font-size:12.0pt;color:#C00000\'>Bold red</span></b><span lang=EN-US> then <i>italic</i> and <u>under</u><o:p></o:p></span></p>',
  '<p class=MsoListParagraphCxSpFirst style=\'text-indent:-18.0pt;mso-list:l0 level1 lfo1\'><![if !supportLists]><span style=\'font-family:Symbol;mso-fareast-font-family:Symbol\'><span style=\'mso-list:Ignore\'>·<span style=\'font:7.0pt "Times New Roman"\'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]><span lang=EN-US>Bullet one<o:p></o:p></span></p>',
  '<p class=MsoListParagraphCxSpMiddle style=\'margin-left:72.0pt;mso-add-space:auto;text-indent:-18.0pt;mso-list:l0 level2 lfo1\'><![if !supportLists]><span style=\'font-family:"Courier New"\'><span style=\'mso-list:Ignore\'>o<span style=\'font:7.0pt "Times New Roman"\'>&nbsp;&nbsp; </span></span></span><![endif]><span lang=EN-US>Nested <b>bullet</b><o:p></o:p></span></p>',
  '<p class=MsoListParagraphCxSpLast style=\'text-indent:-18.0pt;mso-list:l0 level1 lfo1\'><![if !supportLists]><span style=\'font-family:Symbol\'><span style=\'mso-list:Ignore\'>·<span style=\'font:7.0pt "Times New Roman"\'>&nbsp;&nbsp; </span></span></span><![endif]><span lang=EN-US>Bullet two<o:p></o:p></span></p>',
  '<p class=MsoListParagraphCxSpFirst style=\'text-indent:-18.0pt;mso-list:l1 level1 lfo2\'><![if !supportLists]><span><span style=\'mso-list:Ignore\'>1.<span style=\'font:7.0pt "Times New Roman"\'>&nbsp;&nbsp; </span></span></span><![endif]><span lang=EN-US>Step one<o:p></o:p></span></p>',
  '<p class=MsoListParagraphCxSpLast style=\'text-indent:-18.0pt;mso-list:l1 level1 lfo2\'><![if !supportLists]><span><span style=\'mso-list:Ignore\'>2.<span style=\'font:7.0pt "Times New Roman"\'>&nbsp;&nbsp; </span></span></span><![endif]><span lang=EN-US>Step two with <a href="https://example.org/">a link</a><o:p></o:p></span></p>',
  '<p class=MsoNormal><span style=\'background:yellow;mso-highlight:yellow\'>Highlighted</span> <s>struck</s><o:p></o:p></p>',
  '<!--EndFragment--></body></html>',
].join('');
