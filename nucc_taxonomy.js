const taxonomies = [];

$(document).ready(function() {
    $('li#flx').each(processListItem);
    $('li#foldheader2').each(processListItem);

    // console.log(taxonomies);
    download(JSON.stringify(taxonomies), `taxonomies.json`, 'text/plain');
});

const download = function (text, name, type) {
    var a = document.createElement("a");
    var file = new Blob([text], {type: type});
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
};

const processListItem = (liIndex, li) => {
    const taxonomy = {
        number: null,
        name: null,
        definitionUrl: null,
    };

    $(li).contents().each((nodeIndex, node) => {
        switch (nodeIndex) {
            case 0:
                if (node.nodeName === "#text") {
                    taxonomy.name = node.nodeValue.replace(/\s{1}-\s{1}$/g, '');
                }
                break;
            case 1:
                if (node.nodeName === "B") {
                    taxonomy.number = node.innerText;
                }
                break;
            case 3:
                if (node.nodeName === "A") {
                    taxonomy.definitionUrl = node.href;
                }
                break;
            default:
                break;
        }
    });

    if (!_.isEmpty(taxonomy.number)) {
        taxonomies.push(taxonomy);
    } else {
        console.log('Empty ', taxonomy.name);
    }
    // console.log(taxonomy);
};