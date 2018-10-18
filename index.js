const rp = require('request-promise'),
    cheerio = require('cheerio'),
    _ = require('lodash'),
    fs = require('fs'),
    json2xls = require('json2xls');

const limit = 0 || Number.MAX_SAFE_INTEGER;

const npis = require('./npis.json'),
    taxonomyCatalog = _.keyBy(require('./taxonomies.json'), 'number');

const taxonomyRegexp = /(^[A-Z0-9]{9}X\s{1})-?(.*$)/g,
    bodyRegexp = /(?:<body>)([\s\S]*)(?:<\/body>)/gmi;

let csvHeaders = null;

const crawlNpiPages = async () => {
    const npiExtracts = [];
    const errors = [];

    let index = 0;
    for (const npi of npis) {
        if (++index > limit) continue;
        // if (npi !== 1669591962) continue;

        const url = `https://npiregistry.cms.hhs.gov/registry/provider-view/${npi}`;

        try {
            let options = {
                uri: url,
                transform: function (body) {
                    return cheerio.load(body);
                }
            };

            const $ = await rp(options);
            if (is404Page($)) {
                errors.push({
                    npi: npi,
                    error: '404 Page Not Found',
                });

                console.error(url, 404);
                continue;
            } else {
                const npiExtract = processPage($);
                npiExtracts.push(formatNpiExtractOutput(npiExtract));
                
                console.log(url, npiExtract.name);
            }

            await sleep(500);
        } catch(err) {
            errors.push({
                npi: npi,
                error: err,
            });
            console.error(url, err);
        }
    }

    await saveAsJsonFile(npiExtracts, 'output');
    saveAsXslFile(npiExtracts, 'output');

    await saveAsJsonFile(errors, 'errors');
    saveAsXslFile(errors, 'errors');

    // await saveAsCsvFile(csvHeaders, npiExtracts, 'output');
    console.log('Done!');
};

function is404Page($) {
    return $('#508focusheader').text().replace(/\s+/gmi, ' ') === '404 Page Not Found';
}

function processPage($) {
    const npiExtract = {
        npi: null,
        primaryTaxonomy: null,
        primaryTaxonomyExtended: null,

        // name
        name: null,
        gender: null,
        lastUpdated: null,

        // details
        enumerationDate: null,
        npiType: null,
        soleProprietor: null,
        status: null,
        mailingAddress: null,
        primaryPracticeAddress: null,
        taxonomy: null,
        otherIdentifiers: null,
    };

    $body = $('body');

    let $content = $body.find('#top > .text > .container.well.span6');
    let $sections = $content.children().map((index, el) => $(el));

    // content.children().each((index, el) => {
    //     console.log(el);
    // });

    /**
     * Name and gender
     */
    let $nameSection = $sections[0],
        $nameBlock = $nameSection.find('> div:nth-child(2)');
    
    const labels = [
        'Gender:',
        'NPI:',
        'Last Updated:',
        'Other Name:',
        'Doing Business As:',
        'Organization Subpart:',
    ];

    let nameBlock = $nameBlock.text().replace(/[\n\r]+/gmi, '').replace(/\s+/gmi, ' ');
    let splitNameBlock = nameBlock.split(new RegExp(`(${labels.join('|')})`, 'i'));

    for(let i=0; i<splitNameBlock.length; i++) {
        let item = splitNameBlock[i];

        switch(item.toLowerCase()) {
            case 'gender:':
            case 'npi:':
            case 'last updated:':
            case 'other name:':
            case 'doing business as:':
            case 'organization subpart:':
                let pascalCaseKey = _.camelCase(item);
                npiExtract[pascalCaseKey] = splitNameBlock[++i].trim();
                break;
            default:
                if (item.trim() !== '') {
                    npiExtract.name = item.trim();
                }
                break;
        }
    }
    // console.log(npiExtract); 

    
    /**
     * Details
     */
    let $detailsSection = $sections[2],
        $header = $detailsSection.find('> h2');
    if ($header.text() === 'Details') {
        let $detailsTableRows = $detailsSection.find('> table > tbody > tr').map((index, el) => $(el));
        $detailsTableRows.each((index, $row) => {
            let lowerCaseKey = $row.children(':nth-child(1)').text().toLowerCase(),
                pascalCaseKey = _.camelCase($row.children(':nth-child(1)').text()),
                $contentCell = $row.children(':nth-child(2)'),
                content = $contentCell.text();

            switch(lowerCaseKey) {
                case 'npi':
                case 'enumeration date':
                case 'npi type':
                case 'sole proprietor':
                case 'status':
                    npiExtract[pascalCaseKey] = content.replace(/\s{2,}\n?\r?/gm, '').trim();
                    break;
                case 'mailing address':
                case 'primary practice address':
                case 'secondary practice address':
                    npiExtract[pascalCaseKey] = parseAddress($contentCell, $);
                    break;
                case 'authorized official information':
                    npiExtract[pascalCaseKey] = 
                        content.replace(/\s{2,}\n?\r?/gm, '\t')
                            .trim()
                            .replace('	View Map', '');
                    break;
                case 'taxonomy':
                    let taxonomies = parseTaxonomy($row.find('table'), $);
                    npiExtract[pascalCaseKey] = taxonomies;
                    if (taxonomies.length > 0 && taxonomies[0]['primaryTaxonomy'].replace(/\s*/g, '') === 'Yes') {
                        npiExtract['primaryTaxonomy'] = taxonomies[0];
                        npiExtract['primaryTaxonomyExtended'] = taxonomyCatalog[taxonomies[0].number.number];
                    }
                    break;
                case 'other identifiers':
                    npiExtract[pascalCaseKey] = content;
                    break;
            }
        });
    }
    // console.log(npiExtract.taxonomy);

    return npiExtract;
}

async function saveAsJsonFile(content, fileName) {
    return new Promise((res, rej) => {
        let fileContent = JSON.stringify(content);

        fs.writeFile(`./${fileName}.json`, fileContent, function(err) {
            if (err) rej(err)
            else res()
        });
    })
}

async function saveAsCsvFile(headers, objectList, fileName) {
    const delimiter = ';';

    return new Promise((res, rej) => {
        // let fileContent = "data:text/csv;charset=utf-8;sep=;,";
        let fileContent = '';
        let headerRow = headers.join(delimiter);
            fileContent += headerRow + "\r\n";

        objectList.forEach(function(item){
            let row = _.values(item).join(delimiter);
            fileContent += row + "\r\n";
        });

        fs.writeFile(`./${fileName}.csv`, fileContent, function(err) {
            if (err) rej(err)
            else res()
        });
    })
}

function saveAsXslFile(content, fileName) {
    var xls = json2xls(content);
    fs.writeFileSync(`./${fileName}.xlsx`, xls, 'binary');
}

function parseTaxonomy($table, $) {
    let taxonomy = [];

    let $theadCells = $table.find('> thead > tr > th'),
        $tbodyRows = $table.find('> tbody > tr');

    // console.log($theadCells.length, $tbodyRows.length)

    $tbodyRows.each((rowIndex, row) => {
        let taxonomyItem = {};

        let $cells = $(row).find('> td');
        $cells.each((cellIndex, cell) => {
            let key = $($theadCells[cellIndex]).text();
            let pascalCaseKey = _.camelCase(key);

            // taxonomyItem[pascalCaseKey] = 
            //     $(cell).text().replace(/\s{2,}\n?\r?/gm, ' ')
            //         .trim();
            taxonomyItem[pascalCaseKey] = $(cell).text();
            
            if (pascalCaseKey === 'selectedTaxonomy') {
                const taxonomyNumber = parseSelectedTaxonomy(taxonomyItem[pascalCaseKey]);
                taxonomyItem.number = taxonomyNumber;
            }
        });

        taxonomy.push(taxonomyItem);
    });

    return taxonomy;
}

function parseSelectedTaxonomy(selectedTaxonomy) {
    const taxonomyNumber = {
        number: null,
        field: null,
        groupNumber: null,
        group: null,
    };

    const splitValue = selectedTaxonomy.split('\n')
        .map((line) => line.replace(/\s{2,}/g, ' ').trim())
        .filter((line) => line !== '');
    
    if (splitValue.length === 1) {
        const regexpResult = applyTaxonomyRegexp(splitValue[0])
        if (regexpResult.number !== null) {
            taxonomyNumber.number = regexpResult.number;
            taxonomyNumber.field = regexpResult.field;
        }
    }

    if (splitValue.length === 2) {
        let regexpResult = applyTaxonomyRegexp(splitValue[0])
        if (regexpResult.groupNumber !== null) {
            taxonomyNumber.groupNumber = regexpResult.number;
            taxonomyNumber.group = regexpResult.field;
        }

        regexpResult = applyTaxonomyRegexp(splitValue[1])
        if (regexpResult.number !== null) {
            taxonomyNumber.number = regexpResult.number;
            taxonomyNumber.field = regexpResult.field;
        }
    }
    
    return taxonomyNumber;
}

function applyTaxonomyRegexp(selectedTaxonomy) {
    const taxonomyNumber = {
        number: null,
        field: null,
    };

    taxonomyRegexp.lastIndex = 0;
    let matches = taxonomyRegexp.exec(selectedTaxonomy);
    if (matches !== null && matches.length > 0) {
        taxonomyNumber.number = matches[1].trim();
        taxonomyNumber.field = matches[2].trim();
    }

    return taxonomyNumber;
}

function parseContactInfo(contactInfo) {
    const info = {
        // address: null,
        phone: null,
        fax: null,
    }

    const splitInfo = contactInfo.split(/(Phone:|Fax:)/);
    for(let i=0; i<splitInfo.length; i++) {
        let item = splitInfo[i];

        switch(item.toLowerCase()) {
            case 'phone:':
            case 'fax:':
                let pascalCaseKey = _.camelCase(item);
                info[pascalCaseKey] = splitInfo[++i].replace('|', '').trim();
                break;
            default:
                // info.address = splitInfo[i];
                break;
        }
    }

    return info;
}

function parseAddress($td, $) {
    const address = {
        line1: null,
        line2: null,
        line3: null,
        contactInfo: null,
    };

    $td.contents().each((nodeIndex, node) => {
        switch (nodeIndex) {
            case 0:
                if (node.type === "text") {
                    address.line1 = node.data.replace(/\s{2,}\n?\r?/gm, ' ').trim();
                }
                break;
            case 2:
                if (node.type === "text") {
                    address.line2 = node.data.replace(/\s{2,}\n?\r?/gm, ' ').trim();
                }
                break;
            case 4:
                if (node.type === "text") {
                    address.line3 = node.data.replace(/\s{2,}\n?\r?/gm, ' ').trim();
                }
                break;
            case 7:
                if (node.type === "text") {
                    address.contactInfo = parseContactInfo(node.data.replace(/\s{2,}\n?\r?/gm, '\t').trim());
                }
                break;
            default:
                break;
        }
    });

    return address;
}

function formatNpiExtractOutput(npiExtract) {
    // return npiExtract;

    // Name
    // Gender
    // Primary practice address
    // Phone number
    // Fax Number
    // Taxonomy Code
    // Taxonomy Specialty
    // State
    // License number

    // "primaryTaxonomyNumber": "363LF0000X",
    //     "primaryTaxonomyExtended": {
    //         "number": "363LF0000X",
    //         "name": "Family",
    //         "definitionUrl": "http://codelists.wpc-edi.com/nucc_properties.asp?IndexID=7937"
    //     },
    //     "primaryTaxonomy": {
    //         "primaryTaxonomy": "Yes",
    //         "selectedTaxonomy": "363LF0000X - Nurse Practitioner Family",
    //         "number": "363LF0000X",
    //         "state": "NC",
    //         "licenseNumber": "5008527"
    //     }

    // console.log(npiExtract)

    if (_.isEmpty(npiExtract.primaryTaxonomy)) {
        throw 'No primary taxonomy';
    }

    const output = {
        npi: npiExtract.npi,
        name: npiExtract.name,
        gender: npiExtract.gender,

        taxonomyGroupNumber: npiExtract.primaryTaxonomy.number.groupNumber,
        taxonomyGroup: npiExtract.primaryTaxonomy.number.group,
        taxonomyNumber: npiExtract.primaryTaxonomy.number.number,
        taxonomyField: npiExtract.primaryTaxonomy.number.field,
        taxonomyState: npiExtract.primaryTaxonomy.state,
        taxonomyLicenseNumber: npiExtract.primaryTaxonomy.licenseNumber,
        taxonomyOriginalValue: npiExtract.primaryTaxonomy.selectedTaxonomy,

        addressLine1: npiExtract.primaryPracticeAddress.line1,
        addressLine2: npiExtract.primaryPracticeAddress.line2,
        addressLine3: npiExtract.primaryPracticeAddress.line3,
        phone: npiExtract.primaryPracticeAddress.contactInfo.phone,
        fax: npiExtract.primaryPracticeAddress.contactInfo.fax,
    }

    if (_.isNil(csvHeaders)) {
        csvHeaders = _.keys(output);
    }

    return output;
}

async function sleep(millis) {
    return new Promise(function (resolve, reject) {
        setTimeout(function () { resolve(); }, millis);
    });
}

crawlNpiPages();